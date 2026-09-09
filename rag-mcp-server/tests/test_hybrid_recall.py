"""hybrid_recall（BM25 索引 + RRF 融合）离线单元测试

BM25 使用内存假 collection（只需 get(include=["documents"]) 接口），
不访问任何网络。
"""

import math

import pytest

from config import Config
from hybrid_recall import BM25Index, _is_pure_punct, rrf_fuse, tokenize


class FakeCollection:
    """最小化的 Chroma collection 假实现，仅提供 BM25Index 需要的 get()"""

    def __init__(self, ids, documents):
        self._ids = ids
        self._documents = documents

    def get(self, include=None):  # noqa: ARG002 - 签名对齐 Chroma
        return {"ids": self._ids, "documents": self._documents}


# ---------------------------------------------------------------------- #
# 分词
# ---------------------------------------------------------------------- #


def test_tokenize_chinese_and_numbers():
    tokens = tokenize("全国大学英语四级考试成绩达到425分")
    joined = "".join(tokens)
    assert "425" in joined  # 数字阈值必须保留
    assert "英语" in tokens or "大学英语" in joined
    assert all(t.strip() for t in tokens)


def test_tokenize_empty():
    assert tokenize("") == []


def test_is_pure_punct():
    assert _is_pure_punct("，")
    assert _is_pure_punct("〔〕")
    assert not _is_pure_punct("425分")
    assert not _is_pure_punct("第五条")


# ---------------------------------------------------------------------- #
# RRF 融合
# ---------------------------------------------------------------------- #


def test_rrf_fuse_prefers_docs_hit_by_both_lists():
    # b 在两路都排第一 -> 融合分最高；a/c 各只被一路召回
    fused = rrf_fuse([["b", "a"], ["b", "c"]], k=60)
    ids = [cid for cid, _ in fused]
    assert ids[0] == "b"
    assert set(ids) == {"a", "b", "c"}
    # b 的分数 = 1/61 + 1/61，a = 1/62
    score = dict(fused)
    assert score["b"] == pytest.approx(2 / 61)
    assert score["a"] == pytest.approx(1 / 62)
    assert score["b"] > score["a"]


def test_rrf_fuse_respects_top_n_and_dedupes():
    fused = rrf_fuse([["a", "b", "c"], ["b", "c", "d"]], top_n=2)
    assert len(fused) == 2
    ids = [cid for cid, _ in fused]
    assert len(set(ids)) == 2  # 去重


def test_rrf_fuse_empty_inputs():
    assert rrf_fuse([]) == []
    assert rrf_fuse([[], []]) == []


def test_rrf_fuse_deterministic_on_ties():
    # 分数相同（都只在一路、同名次）时按 id 稳定排序，结果可复现
    f1 = rrf_fuse([["z", "a"]])
    f2 = rrf_fuse([["z", "a"]])
    assert [c for c, _ in f1] == [c for c, _ in f2]


# ---------------------------------------------------------------------- #
# BM25 索引
# ---------------------------------------------------------------------- #


def test_bm25_query_hits_exact_keyword():
    """BM25 的核心价值：精确 token（文号/数字阈值）必须能召回"""
    coll = FakeCollection(
        ids=["c1", "c2", "c3"],
        documents=[
            "全国大学英语四级考试成绩达到425分及其以上方可申请推免",
            "奖学金评定于每年九月进行由学生本人提出申请",
            "重庆邮电大学文件重邮〔2024〕15号关于印发推免细则的通知",
        ],
    )
    index = BM25Index()

    hits, err = index.query(coll, "英语四级需要多少分425", top_n=3)
    assert err is None
    assert hits
    assert hits[0] == "c1"  # 含「四级」「425」的块排第一

    # 文号精确匹配 —— 向量检索的弱项，BM25 应命中
    hits2, err2 = index.query(coll, "重邮〔2024〕15号", top_n=3)
    assert err2 is None
    assert "c3" in hits2


def test_bm25_cache_invalidation_on_bump():
    coll = FakeCollection(ids=["c1"], documents=["alpha content"])
    index = BM25Index()
    hits, _ = index.query(coll, "alpha", top_n=5)
    assert hits == ["c1"]

    # 知识库更新：同一 collection 对象内容变化后 bump_version 应触发重建
    coll._documents = ["beta content"]
    coll._ids = ["c2"]
    index.bump_version()
    hits2, _ = index.query(coll, "beta", top_n=5)
    assert hits2 == ["c2"]
    # 旧内容不再被召回
    hits3, err3 = index.query(coll, "alpha", top_n=5)
    assert hits3 == [] or err3 is not None


def test_bm25_no_match_returns_reason():
    coll = FakeCollection(ids=["c1"], documents=["alpha content"])
    index = BM25Index()
    hits, err = index.query(coll, "zzzqqq", top_n=5)
    assert hits == []
    assert err and "无匹配" in err


def test_bm25_disabled_via_config(monkeypatch):
    monkeypatch.setattr(Config, "BM25_ENABLED", False)
    coll = FakeCollection(ids=["c1"], documents=["alpha content"])
    index = BM25Index()
    hits, err = index.query(coll, "alpha", top_n=5)
    assert hits == []
    assert err and "关闭" in err


def test_bm25_empty_query_and_empty_index():
    coll = FakeCollection(ids=[], documents=[])
    index = BM25Index()
    assert index.query(coll, "", top_n=5)[0] == []
    hits, err = index.query(coll, "anything", top_n=5)
    assert hits == []
    assert err  # 空索引给出显式原因而非静默


def test_bm25_survives_all_punct_documents():
    """全标点文档不应导致 BM25Okapi 除零崩溃"""
    coll = FakeCollection(ids=["c1", "c2"], documents=["。。。", "alpha real content"])
    index = BM25Index()
    hits, err = index.query(coll, "alpha", top_n=5)
    assert err is None
    assert hits == ["c2"]
