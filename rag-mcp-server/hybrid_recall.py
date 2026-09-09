"""混合召回 - BM25 关键词检索 + RRF（Reciprocal Rank Fusion）融合

为什么需要 BM25:
    向量检索对「语义相近」敏感，但对精确 token 天然弱势。政策文件里大量关键信息
    恰恰是精确 token：文号（重邮〔2024〕15号）、条款号（第五条）、学院专名、
    数字阈值（425分、前50%）。这类查询向量召回容易漏，BM25 能精准命中。

设计要点:
- BM25 索引带缓存：知识库规模下每次查询重新分词全量文档代价过高。
  缓存按「写版本号」失效 —— 引擎在 load/delete/clear 后调用 bump_version()。
- jieba / rank_bm25 延迟导入且异常兜底：缺依赖或建索引失败时**显式降级**为
  纯向量召回，并记录原因，绝不静默返回残缺结果。
- 日志只写 stderr，绝不碰 stdout（stdio MCP 协议通道）。
"""

import logging
import math
import threading
from typing import Any, Iterable

from config import Config

logger = logging.getLogger("hybrid_recall")

# jieba 首次加载词典较慢（约 1~2s），进程内只加载一次
_JIEBA_READY = False
_JIEBA_LOCK = threading.Lock()


def _ensure_jieba() -> Any:
    """加载并返回 jieba 模块（首次调用会构建词典缓存）"""
    global _JIEBA_READY
    with _JIEBA_LOCK:
        if not _JIEBA_READY:
            import jieba

            # 关掉 jieba 自己的初始化日志，避免污染 stderr
            jieba.setLogLevel(logging.WARNING)
            _JIEBA_READY = True
            logger.info("jieba 分词器初始化完成")
        import jieba

        return jieba


def tokenize(text: str) -> list[str]:
    """中文感知分词：jieba 精确模式 + 过滤空白与单字符标点

    保留数字与英文 token（425分、CET-4 这类阈值信息对 BM25 至关重要）。
    """
    if not text:
        return []
    jieba = _ensure_jieba()
    tokens = [t.strip() for t in jieba.lcut(text)]
    return [t for t in tokens if t and not _is_pure_punct(t)]


def _is_pure_punct(token: str) -> bool:
    """判断 token 是否全为标点/符号（这类 token 对 BM25 无区分度）"""
    return all(not (ch.isalnum() or "\u4e00" <= ch <= "\u9fff") for ch in token)


class BM25Index:
    """带版本缓存的 BM25 索引

    典型用法::

        index = BM25Index()
        hits = index.query(collection, "推免 英语四级", top_n=20)
        # 知识库写入后：
        index.bump_version()
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._version = 0
        self._built_version = -1
        self._bm25: Any = None
        self._ids: list[str] = []
        self._token_sets: list[set[str]] = []
        self._disabled_reason: str | None = None

    # ------------------------------------------------------------------ #
    # 缓存管理
    # ------------------------------------------------------------------ #

    def bump_version(self) -> None:
        """知识库发生写入（load/delete/clear）后调用，使索引缓存失效"""
        with self._lock:
            self._version += 1
            self._bm25 = None
            self._ids = []
            self._token_sets = []

    @property
    def version(self) -> int:
        return self._version

    # ------------------------------------------------------------------ #
    # 查询
    # ------------------------------------------------------------------ #

    def query(self, collection: Any, query: str, top_n: int) -> tuple[list[str], str | None]:
        """BM25 检索，返回 (按分数降序的 chunk id 列表, 降级原因或 None)

        任何失败都返回 ([], 原因)，由调用方回退到纯向量召回。
        """
        if not Config.BM25_ENABLED:
            return [], "BM25 已通过配置关闭（BM25_ENABLED=false）"

        if not query or not query.strip():
            return [], "query 为空"

        try:
            self._ensure_built(collection)
        except Exception as e:  # noqa: BLE001 - 建索引失败不应中断检索
            reason = f"BM25 索引构建失败: {type(e).__name__}: {e}"
            logger.error("%s，降级为纯向量召回", reason)
            return [], reason

        with self._lock:
            bm25, ids = self._bm25, list(self._ids)
            token_sets = list(self._token_sets)

        if bm25 is None or not ids:
            return [], "BM25 索引为空（知识库无文档）"

        try:
            q_tokens = tokenize(query)
        except Exception as e:  # noqa: BLE001
            reason = f"查询分词失败: {type(e).__name__}: {e}"
            logger.error("%s，降级为纯向量召回", reason)
            return [], reason

        if not q_tokens:
            return [], "查询分词后无有效 token"

        try:
            scores = bm25.get_scores(q_tokens)
        except Exception as e:  # noqa: BLE001
            reason = f"BM25 打分失败: {type(e).__name__}: {e}"
            logger.error("%s，降级为纯向量召回", reason)
            return [], reason

        # 以「词面重叠」而非「BM25 分数符号」判定是否召回。
        # rank_bm25 的 IDF = log((N-n+0.5)/(n+0.5)) 在小语料下会退化：
        #   N=1            -> idf = log(0.5)-log(1.5) = -1.098（负分）
        #   N=2, n=1       -> idf = log(1.5)-log(1.5) = 0（零分）
        # 若按 score<=0 过滤，小知识库下 BM25 整路会静默失效退化为纯向量检索。
        # 而 RRF 融合只依赖**名次**不依赖分数，分数正负对融合毫无影响，
        # 因此这里只剔除 NaN/inf 与非有限值，重叠判定交给 token 集合。
        q_set = {t for t in q_tokens}
        ranked: list[tuple[float, str]] = []
        for score, cid, doc_tokens in zip(scores, ids, token_sets):
            try:
                s = float(score)
            except (TypeError, ValueError):
                continue
            if math.isnan(s) or math.isinf(s):
                continue
            # 与查询无任何词面重叠的块不参与召回（即使 IDF 退化给了非零分）
            if not (q_set & doc_tokens):
                continue
            ranked.append((s, cid))

        if not ranked:
            return [], "BM25 无匹配（查询词与知识库无任何词面重叠）"

        # 分数降序；退化语料下分数可能全相等甚至为负，用 id 作次级键保证可复现
        ranked.sort(key=lambda x: (-x[0], x[1]))
        hits = [cid for _, cid in ranked[:top_n]]
        shown = ranked[: len(hits)]
        logger.info(
            "BM25 召回 %d 条（最高分 %.4f，最低分 %.4f）",
            len(hits),
            shown[0][0],
            shown[-1][0],
        )
        return hits, None

    # ------------------------------------------------------------------ #
    # 内部
    # ------------------------------------------------------------------ #

    def _ensure_built(self, collection: Any) -> None:
        """若缓存已失效则重建索引（持锁期间完成，避免并发重复构建）"""
        with self._lock:
            if self._bm25 is not None and self._built_version == self._version:
                return

            from rank_bm25 import BM25Okapi

            data = collection.get(include=["documents"])
            ids: list[str] = list(data.get("ids") or [])
            docs: list[str] = list(data.get("documents") or [])

            if not ids or not docs:
                self._bm25 = None
                self._ids = []
                self._token_sets = []
                self._built_version = self._version
                logger.info("知识库为空，BM25 索引置空")
                return

            started_ids = len(ids)
            tokenized = [tokenize(d or "") for d in docs]
            # 全空文档会导致 BM25Okapi 除零，用占位 token 兜底
            # （占位符 \x00 不可能出现在任何真实查询中，因此不会造成误召回）
            corpus = [c if c else ["\x00"] for c in tokenized]

            self._bm25 = BM25Okapi(corpus)
            self._ids = ids
            # 与 corpus 对齐的词面集合，用于「重叠才召回」判定（规避小语料 IDF 退化）
            self._token_sets = [set(c) for c in corpus]
            self._built_version = self._version
            logger.info(
                "BM25 索引构建完成（version=%d, 文档数=%d, 平均 token 数=%.1f）",
                self._version,
                started_ids,
                sum(len(c) for c in corpus) / len(corpus),
            )


def rrf_fuse(
    ranked_lists: Iterable[Iterable[str]],
    k: int | None = None,
    top_n: int | None = None,
) -> list[tuple[str, float]]:
    """RRF（Reciprocal Rank Fusion）融合多路召回结果

    score(d) = Σ_lists 1 / (k + rank_d)，rank 为 1-based 名次。

    RRF 只依赖**名次**不依赖分数，因此天然规避了「BM25 分数与余弦相似度量纲
    不可比」的问题 —— 这是它优于加权求和的关键。

    Args:
        ranked_lists: 多路召回结果，每路是按相关性降序的 id 序列
        k: 平滑常数，默认取 Config.RRF_K（经验值 60）
        top_n: 返回条数上限，None 表示全部

    Returns:
        [(id, rrf_score), ...] 按融合分数降序
    """
    k = k if k is not None else Config.RRF_K
    fused: dict[str, float] = {}
    paths = 0

    for ids in ranked_lists:
        ids = list(ids)
        if not ids:
            continue
        paths += 1
        for rank, cid in enumerate(ids, start=1):
            fused[cid] = fused.get(cid, 0.0) + 1.0 / (k + rank)

    if not fused:
        return []

    # 分数相同（如都只被一路召回且名次相同）时按 id 稳定排序，保证结果可复现
    ordered = sorted(fused.items(), key=lambda x: (-x[1], x[0]))
    if top_n is not None:
        ordered = ordered[:top_n]

    logger.info("RRF 融合 %d 路召回 -> %d 个去重候选", paths, len(ordered))
    return ordered
