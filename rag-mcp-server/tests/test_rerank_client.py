"""rerank_client 离线单元测试

通过 monkeypatch 替换 dashscope.TextReRank 与开关配置，不访问网络。
核心验证点：失败时必须**显式降级**（applied=False + 可读 error），
绝不静默返回看似正常的结果。
"""

import logging

import pytest

import rerank_client
from config import Config
from rerank_client import RerankOutcome, outcome_to_meta, rerank_documents

QUERY = "推免生需要英语四级多少分"
DOCS = [
    "全国大学英语四级考试成绩达到425分及其以上方可申请推免。",
    "奖学金评定于每年九月进行。",
    "学生转专业需满足无不及格记录。",
]


class _FakeResp:
    def __init__(self, status_code=200, output=None, message=""):
        self.status_code = status_code
        self.output = output
        self.message = message


@pytest.fixture(autouse=True)
def _enable(monkeypatch):
    monkeypatch.setattr(Config, "RERANK_ENABLED", True)
    monkeypatch.setattr(Config, "RERANK_MAX_RETRIES", 1)  # 加速失败路径
    monkeypatch.setattr(Config, "RERANK_MODEL", "gte-rerank-v2")


def _patch_sdk(monkeypatch, fake_call):
    """把 dashscope.TextReRank.call 替换为 fake_call"""
    import types

    import dashscope

    fake_rerank = types.SimpleNamespace(call=staticmethod(fake_call))
    monkeypatch.setattr(dashscope, "TextReRank", fake_rerank, raising=False)


# ---------------------------------------------------------------------- #
# 成功路径
# ---------------------------------------------------------------------- #


def test_rerank_success_dict_output(monkeypatch):
    """SDK 返回 dict 形态 results 时应正确解析分数与排序"""

    def fake_call(**kwargs):
        assert kwargs["model"] == "gte-rerank-v2"
        assert kwargs["return_documents"] is False
        return _FakeResp(
            output={
                "results": [
                    {"index": 0, "relevance_score": 0.7791},
                    {"index": 1, "relevance_score": 0.0060},
                    {"index": 2, "relevance_score": 0.0865},
                ]
            }
        )

    _patch_sdk(monkeypatch, fake_call)
    outcome = rerank_documents(QUERY, DOCS)

    assert outcome.applied is True
    assert outcome.error is None
    assert outcome.model == "gte-rerank-v2"
    assert outcome.scores == [0.7791, 0.006, 0.0865]
    assert outcome.order[0] == 0  # 最相关的排第一


def test_rerank_success_object_output(monkeypatch):
    """SDK 返回对象形态 results（属性访问）时也应正确解析"""

    class Item:
        def __init__(self, index, relevance_score):
            self.index = index
            self.relevance_score = relevance_score

    def fake_call(**kwargs):
        return _FakeResp(output={"results": [Item(2, 0.9), Item(0, 0.4), Item(1, 0.1)]})

    _patch_sdk(monkeypatch, fake_call)
    outcome = rerank_documents(QUERY, DOCS)

    assert outcome.applied is True
    assert outcome.scores[2] == 0.9
    assert outcome.order == [2, 0, 1]


def test_rerank_single_doc_short_circuits(monkeypatch):
    """单条文档无需调用 API"""
    called = []
    _patch_sdk(monkeypatch, lambda **kw: called.append(1))

    outcome = rerank_documents(QUERY, ["only one doc"])
    assert outcome.applied is True
    assert outcome.scores == [1.0]
    assert called == []  # 未触发网络调用


def test_rerank_empty_docs(monkeypatch):
    _patch_sdk(monkeypatch, lambda **kw: pytest.fail("不应调用 API"))
    outcome = rerank_documents(QUERY, [])
    assert outcome.applied is True
    assert outcome.scores == []
    assert outcome.order == []


# ---------------------------------------------------------------------- #
# 降级路径（核心：必须显式，不可静默）
# ---------------------------------------------------------------------- #


def test_rerank_disabled_by_config(monkeypatch):
    monkeypatch.setattr(Config, "RERANK_ENABLED", False)
    _patch_sdk(monkeypatch, lambda **kw: pytest.fail("关闭时不应调用 API"))

    outcome = rerank_documents(QUERY, DOCS)
    assert outcome.applied is False
    assert "关闭" in outcome.error
    assert outcome.scores == [None, None, None]


def test_rerank_api_error_degrades_explicitly(monkeypatch, caplog):
    """API 报错 -> 降级 + 大声记日志（前车之鉴：静默失败曾导致结果全空难排查）"""

    def fake_call(**kwargs):
        return _FakeResp(status_code=400, message="url error, please check url")

    _patch_sdk(monkeypatch, fake_call)
    with caplog.at_level(logging.ERROR, logger="rerank_client"):
        outcome = rerank_documents(QUERY, DOCS)

    assert outcome.applied is False
    assert "400" in outcome.error
    assert "url error" in outcome.error
    assert outcome.scores == [None] * len(DOCS)
    # 降级必须是响亮的：有 ERROR 级日志
    assert any(r.levelno >= logging.ERROR for r in caplog.records)


def test_rerank_exception_degrades_without_raising(monkeypatch):
    """SDK 抛异常也不应向上冒泡中断检索"""

    def fake_call(**kwargs):
        raise ConnectionError("network down")

    _patch_sdk(monkeypatch, fake_call)
    outcome = rerank_documents(QUERY, DOCS)  # 不应抛异常

    assert outcome.applied is False
    assert "ConnectionError" in outcome.error
    assert "network down" in outcome.error


def test_rerank_empty_results_degrades(monkeypatch):
    def fake_call(**kwargs):
        return _FakeResp(output={"results": []})

    _patch_sdk(monkeypatch, fake_call)
    outcome = rerank_documents(QUERY, DOCS)
    assert outcome.applied is False
    assert "为空" in outcome.error


def test_rerank_empty_query(monkeypatch):
    _patch_sdk(monkeypatch, lambda **kw: pytest.fail("空 query 不应调用 API"))
    outcome = rerank_documents("   ", DOCS)
    assert outcome.applied is False
    assert "query 为空" in outcome.error


def test_rerank_truncates_over_limit(monkeypatch):
    """候选数超过单次上限时截断而非报错"""
    monkeypatch.setattr(Config, "RERANK_MAX_DOCS", 2)
    seen = {}

    def fake_call(**kwargs):
        seen["n_docs"] = len(kwargs["documents"])
        return _FakeResp(
            output={"results": [{"index": i, "relevance_score": 0.9 - 0.1 * i} for i in range(len(kwargs["documents"]))]}
        )

    _patch_sdk(monkeypatch, fake_call)
    outcome = rerank_documents(QUERY, ["d1", "d2", "d3", "d4"])

    assert seen["n_docs"] == 2  # 只送了前 2 条
    assert outcome.applied is True
    assert len(outcome.scores) == 2


# ---------------------------------------------------------------------- #
# 降级元数据
# ---------------------------------------------------------------------- #


def test_outcome_to_meta_success():
    meta = outcome_to_meta(RerankOutcome(applied=True, scores=[0.9], order=[0], model="gte-rerank-v2"))
    assert meta["rerank_applied"] is True
    assert meta["rerank_model"] == "gte-rerank-v2"
    assert "rerank_error" not in meta
    assert "rerank_hint" not in meta


def test_outcome_to_meta_degraded():
    """降级时元数据必须带错误原因与提示，让 Agent 知道结果未经精排"""
    meta = outcome_to_meta(
        RerankOutcome(applied=False, scores=[None], error="rerank 调用失败已降级: boom", model="gte-rerank-v2")
    )
    assert meta["rerank_applied"] is False
    assert meta["rerank_error"] == "rerank 调用失败已降级: boom"
    assert "未经重排序精排" in meta["rerank_hint"]


# ---------------------------------------------------------------------- #
# 超时接线回归测试
# ---------------------------------------------------------------------- #


def test_rerank_uses_request_timeout_not_timeout(monkeypatch):
    """必须用 request_timeout 下发 HTTP 超时，禁止使用 timeout

    实测（dashscope 1.27.4）：
      - request_timeout 是 SDK `_build_api_request` 的**具名参数**，会被消费并
        真正传给 requests 作为读超时。传 0.001 会抛 ReadTimeout，证明生效。
      - timeout 不是具名参数，会被 `_build_rerank_request` 收进 kwargs，
        进而塞进请求 body 的 `parameters` 字段发给服务端，并被**静默忽略**
        （返回 200）。这会造出「看似有超时保护、实际无限挂住」的假象，
        rerank 卡住时整个 MCP 工具调用会一起挂死。
    本测试把这条教训锁死，防止后续改动误用 timeout。
    """
    seen: dict = {}

    def fake_call(**kwargs):
        seen.update(kwargs)
        return _FakeResp(
            output={"results": [{"index": 0, "relevance_score": 0.9},
                                {"index": 1, "relevance_score": 0.1},
                                {"index": 2, "relevance_score": 0.01}]}
        )

    _patch_sdk(monkeypatch, fake_call)
    monkeypatch.setattr(Config, "RERANK_TIMEOUT", 42)

    outcome = rerank_documents(QUERY, DOCS)
    assert outcome.applied is True

    assert seen.get("request_timeout") == 42, "超时未通过 request_timeout 下发，实际无超时保护"
    assert "timeout" not in seen, (
        "使用了 timeout 参数：它会被塞进请求 body 的 parameters 并被服务端忽略，"
        "造成假超时。必须改用 request_timeout。"
    )


def test_rerank_timeout_triggers_explicit_degradation(monkeypatch, caplog):
    """HTTP 超时异常必须走显式降级路径，不可静默返回低质量结果"""

    def fake_call(**kwargs):
        # 模拟 requests 超时：SDK 实测抛的是 ReadTimeout（TimeoutError 子类）
        raise TimeoutError("HTTPSConnectionPool(host='dashscope.aliyuncs.com'): Read timed out.")

    _patch_sdk(monkeypatch, fake_call)
    monkeypatch.setattr(Config, "RERANK_MAX_RETRIES", 2)

    with caplog.at_level(logging.ERROR, logger="rerank_client"):
        outcome = rerank_documents(QUERY, DOCS)

    assert outcome.applied is False, "超时必须降级为 applied=False"
    assert outcome.error and "timed out" in outcome.error
    assert all(s is None for s in outcome.scores), "降级时分数不可用，必须全为 None"

    meta = outcome_to_meta(outcome)
    assert meta["rerank_applied"] is False
    assert "rerank_error" in meta and "rerank_hint" in meta
    assert any("降级" in r.message for r in caplog.records), "降级必须在 stderr 留痕"
