"""重排序（rerank）客户端 - 调用 DashScope 重排序模型对候选文档块精排

设计要点:
- 两阶段检索的第二阶段：粗召回（向量 + BM25）产出宽候选集，由本模块按
  query 与文档的真实相关性重新打分排序，解决纯向量余弦区分度差的问题。
- 失败必须**显式降级**，绝不静默返回低质量结果：返回 rerank_applied=False
  与 rerank_error，由调用方决定是否回退到向量分数，并透传给 Agent 与日志。
  （前车之鉴：LLM 静默失败曾导致条件提取结果全空，排查耗时很久）
- 日志只写 stderr，绝不碰 stdout（stdio MCP 协议通道）。
"""

import logging
import time
from dataclasses import dataclass, field
from typing import Any

from config import Config

logger = logging.getLogger("rerank_client")


@dataclass
class RerankOutcome:
    """一次重排序的结果

    Attributes:
        applied: 是否成功应用了 rerank。False 表示已降级，scores 不可用于过滤。
        scores: 与输入 documents 等长的相关性分数列表（0~1），applied=False 时全为 None。
        order: 按分数降序排列的原始下标，applied=False 时为空列表。
        error: 降级原因（人类可读），成功时为 None。
        model: 实际使用的模型名，便于排查与 A/B 对比。
    """

    applied: bool
    scores: list[float | None] = field(default_factory=list)
    order: list[int] = field(default_factory=list)
    error: str | None = None
    model: str = ""


def rerank_documents(
    query: str,
    documents: list[str],
    top_n: int | None = None,
) -> RerankOutcome:
    """对候选文档块按与 query 的相关性重排序

    Args:
        query: 用户问题
        documents: 候选文档块原文列表
        top_n: 保留的条数上限，None 表示全部保留（仅重排不截断）

    Returns:
        RerankOutcome。任何异常都被捕获并转为显式降级，不向上抛出。
    """
    model = Config.RERANK_MODEL

    # 关闭开关：直接降级，不算错误
    if not Config.RERANK_ENABLED:
        logger.info("rerank 已通过配置关闭（RERANK_ENABLED=false），使用纯向量/BM25 排序")
        return RerankOutcome(
            applied=False,
            scores=[None] * len(documents),
            error="rerank 已通过配置关闭（RERANK_ENABLED=false）",
            model=model,
        )

    if not query or not query.strip():
        return RerankOutcome(
            applied=False,
            scores=[None] * len(documents),
            error="query 为空，无法重排序",
            model=model,
        )

    if not documents:
        return RerankOutcome(applied=True, scores=[], order=[], model=model)

    # 单条文档无需排序
    if len(documents) == 1:
        return RerankOutcome(applied=True, scores=[1.0], order=[0], model=model)

    # 超出单次上限时截断（粗召回窗口通常远小于上限，这里只是防御）
    docs = documents[: Config.RERANK_MAX_DOCS]
    if len(docs) < len(documents):
        logger.warning(
            "候选文档数 %d 超过 rerank 单次上限 %d，仅对前 %d 条重排序",
            len(documents),
            Config.RERANK_MAX_DOCS,
            len(docs),
        )

    n = top_n if top_n is not None else len(docs)
    n = max(1, min(n, len(docs)))

    last_error: Exception | None = None
    for attempt in range(Config.RERANK_MAX_RETRIES):
        try:
            logger.info(
                "rerank 调用开始 (model=%s, query长度=%d, 文档数=%d, top_n=%d)",
                model,
                len(query),
                len(docs),
                n,
            )
            started = time.monotonic()

            # 延迟导入：未启用 rerank 时不强依赖 dashscope
            import dashscope
            from dashscope import TextReRank

            dashscope.api_key = Config.DASHSCOPE_API_KEY

            response = TextReRank.call(
                model=model,
                query=query,
                documents=docs,
                top_n=n,
                return_documents=False,  # 只要分数与下标，省流量
                # 必须用 request_timeout 而不是 timeout：
                # request_timeout 是 SDK _build_api_request 的具名参数，会被消费并
                # 真正下发给 requests 作为 HTTP 读超时（实测 timeout=0.001 会抛
                # ReadTimeout）；而 timeout 不是具名参数，会被塞进请求 body 的
                # parameters 里发给服务端并被静默忽略（返回 200），
                # 那样只会造出「看似有超时保护、实际会无限挂住」的假象，
                # 一旦 rerank 卡住整个 MCP 工具调用都会一起挂死。
                # SDK 默认值是 300 秒，对交互式检索过长，这里收紧到配置值。
                request_timeout=Config.RERANK_TIMEOUT,
            )

            if response.status_code != 200:
                raise RuntimeError(
                    f"Rerank API 返回 {response.status_code}: {response.message}"
                )

            raw_results = getattr(response.output, "results", None)
            if raw_results is None and isinstance(response.output, dict):
                raw_results = response.output.get("results")
            if not raw_results:
                raise RuntimeError(f"Rerank API 返回结果为空: {response.output!r}")

            scores: list[float | None] = [None] * len(docs)
            order: list[int] = []
            for item in raw_results:
                # SDK 对象与 dict 两种形态都要兼容
                if isinstance(item, dict):
                    idx, score = item.get("index"), item.get("relevance_score")
                else:
                    idx, score = getattr(item, "index", None), getattr(item, "relevance_score", None)
                if idx is None or score is None:
                    continue
                idx = int(idx)
                if 0 <= idx < len(docs):
                    scores[idx] = round(float(score), 4)
                    order.append(idx)

            if not order:
                raise RuntimeError(f"Rerank 返回结果不含有效下标: {raw_results!r}")

            elapsed = (time.monotonic() - started) * 1000
            logger.info(
                "rerank 调用成功 (%.0fms)，最高分 %.4f，最低分 %.4f",
                elapsed,
                max(s for s in scores if s is not None),
                min(s for s in scores if s is not None),
            )
            return RerankOutcome(applied=True, scores=scores, order=order, model=model)

        except Exception as e:  # noqa: BLE001 - 统一记日志后重试/降级
            last_error = e
            wait = 2**attempt
            logger.warning(
                "Rerank 调用失败（第 %d/%d 次）: %s: %s",
                attempt + 1,
                Config.RERANK_MAX_RETRIES,
                type(e).__name__,
                e,
            )
            if attempt < Config.RERANK_MAX_RETRIES - 1:
                time.sleep(wait)

    # 所有重试都失败：显式降级，不抛异常
    message = f"{type(last_error).__name__}: {last_error}"
    logger.error(
        "Rerank 连续 %d 次调用失败，降级为纯向量/BM25 排序。原因: %s",
        Config.RERANK_MAX_RETRIES,
        message,
    )
    return RerankOutcome(
        applied=False,
        scores=[None] * len(docs),
        error=f"rerank 调用失败已降级: {message}",
        model=model,
    )


def outcome_to_meta(outcome: RerankOutcome) -> dict[str, Any]:
    """把降级信息整理成可放进检索响应的元数据字段

    始终包含 rerank_applied；降级时额外给出 rerank_error，
    让 Agent 与调用方明确知道当前结果未经精排、可信度较低。
    """
    meta: dict[str, Any] = {"rerank_applied": outcome.applied, "rerank_model": outcome.model}
    if not outcome.applied:
        meta["rerank_error"] = outcome.error
        meta["rerank_hint"] = (
            "当前结果未经重排序精排，排序依据为向量/BM25 相似度，精度可能下降。"
        )
    return meta
