"""Behavior tests for the isolated curriculum vector index."""

from __future__ import annotations

import anyio
import sys
from pathlib import Path
from typing import Any

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from schemas.curriculum_search import CurriculumSearchInput, CurriculumSearchInputError
from server import handle_curriculum_search
from tools.curriculum_search import CurriculumSearchError, CurriculumSearchIndex


class FakeCollection:
    metadata = {"embedding_model": "text-embedding-v4"}

    def __init__(self) -> None:
        self.items: list[dict[str, Any]] = []
        self.last_query: dict[str, Any] = {}

    def count(self) -> int:
        return len(self.items)

    def delete(self, **kwargs: Any) -> None:
        where = kwargs.get("where", {})
        self.items = [
            item
            for item in self.items
            if not all(item["metadata"].get(key) == value for key, value in where.items())
        ]

    def upsert(
        self,
        *,
        ids: list[str],
        embeddings: list[list[float]],
        metadatas: list[dict[str, Any]],
        documents: list[str],
    ) -> None:
        self.items.extend(
            {
                "id": item_id,
                "embedding": embedding,
                "metadata": metadata,
                "document": document,
            }
            for item_id, embedding, metadata, document in zip(ids, embeddings, metadatas, documents)
        )

    def query(self, **kwargs: Any) -> dict[str, Any]:
        self.last_query = kwargs
        return {
            "metadatas": [
                [
                    {
                        "knowledge_base": "curriculum",
                        "document_id": "curriculum-cs-2026",
                        "major": "computer-science",
                        "cohort": "2026",
                        "version": "2026.1",
                        "original_filename": "培养方案.pdf",
                        "page": 8,
                        "chunk_index": 2,
                    },
                    {
                        "knowledge_base": "curriculum",
                        "document_id": "curriculum-cs-2026",
                        "major": "computer-science",
                        "cohort": "2026",
                        "version": "2026.1",
                        "original_filename": "培养方案.pdf",
                        "page": 9,
                        "chunk_index": 3,
                    },
                ]
            ],
            "documents": [["数据结构为专业必修课。", "与问题无关的内容。"]],
            "distances": [[0.1, 0.9]],
        }

    def get(self, **kwargs: Any) -> dict[str, Any]:
        where = kwargs.get("where")
        selected = [item for item in self.items if _matches_where(item.get("metadata", {}), where)]
        return {
            "metadatas": [item.get("metadata", {}) for item in selected],
            "documents": [item.get("document", "") for item in selected],
        }


def _matches_where(metadata: dict[str, Any], where: dict[str, Any] | None) -> bool:
    if where is None:
        return True
    clauses = where.get("$and")
    if isinstance(clauses, list):
        return all(_matches_where(metadata, clause) for clause in clauses)
    return all(metadata.get(key) == value for key, value in where.items())


def _document() -> dict[str, str]:
    return {
        "document_id": "curriculum-cs-2026",
        "knowledge_base": "curriculum",
        "major": "computer-science",
        "cohort": "2026",
        "version": "2026.1",
        "original_filename": "培养方案.pdf",
    }


def test_search_input_rejects_an_out_of_range_top_k() -> None:
    with pytest.raises(CurriculumSearchInputError) as error:
        CurriculumSearchInput.from_payload({"query": "毕业要求", "top_k": 21})

    assert error.value.details["reason"] == "top_k_must_be_integer_between_1_and_20"


def test_index_keeps_curriculum_metadata_and_page_evidence(tmp_path: Path) -> None:
    collection = FakeCollection()
    index = CurriculumSearchIndex(
        tmp_path,
        collection=collection,
        embedder=lambda texts: [[float(position)] for position, _text in enumerate(texts)],
    )

    count = index.index_sources(
        _document(),
        [
            {
                "document": "培养方案.pdf",
                "page": 8,
                "content": "数据结构为专业必修课。",
                "chunk_index": 2,
            }
        ],
    )

    assert count == 1
    assert collection.items[0]["metadata"]["knowledge_base"] == "curriculum"
    assert collection.items[0]["metadata"]["page"] == 8


def test_reindex_replaces_old_chunks_for_the_same_document(tmp_path: Path) -> None:
    collection = FakeCollection()
    index = CurriculumSearchIndex(tmp_path, collection=collection, embedder=lambda texts: [[0.1] for _ in texts])

    index.index_sources(_document(), [{"content": "旧内容", "page": 1, "chunk_index": 0}])
    index.index_sources(_document(), [{"content": "新内容", "page": 2, "chunk_index": 0}])

    assert [item["document"] for item in collection.items] == ["新内容"]


def test_search_uses_local_lexical_matches_without_calling_the_embedder(tmp_path: Path) -> None:
    collection = FakeCollection()
    collection.items.append(
        {
            "metadata": {
                **_document(),
                "page": 12,
                "chunk_index": 4,
                "original_filename": "培养方案.pdf",
            },
            "document": "毕业最低学分要求为专业课程与实践课程规定学分之和。",
        }
    )

    def unexpected_embedding(_texts: list[str]) -> list[list[float]]:
        raise AssertionError("an obvious lexical match must not call the embedding service")

    index = CurriculumSearchIndex(tmp_path, collection=collection, embedder=unexpected_embedding)
    result = index.search(
        CurriculumSearchInput.from_payload(
            {
                "query": "毕业学分要求和课程类别",
                "document_id": "curriculum-cs-2026",
                "top_k": 5,
            }
        )
    )

    assert result["search_mode"] == "lexical"
    assert result["match_count"] == 1
    assert result["sources"][0]["page"] == 12


def test_search_returns_immediately_when_local_evidence_is_absent_by_default(tmp_path: Path) -> None:
    collection = FakeCollection()
    collection.items.append(
        {
            "metadata": {**_document(), "page": 2, "chunk_index": 0},
            "document": "培养目标与专业简介。",
        }
    )

    def unexpected_embedding(_texts: list[str]) -> list[list[float]]:
        raise AssertionError("semantic fallback must be opt-in")

    index = CurriculumSearchIndex(tmp_path, collection=collection, embedder=unexpected_embedding)
    result = index.search(CurriculumSearchInput.from_payload({"query": "完全无关的问题"}))

    assert result["search_mode"] == "lexical"
    assert result["match_count"] == 0
    assert result["sources"] == []


def test_search_applies_catalog_filters_and_similarity_threshold(tmp_path: Path) -> None:
    collection = FakeCollection()
    collection.items.append({"metadata": {"knowledge_base": "curriculum"}})
    index = CurriculumSearchIndex(
        tmp_path,
        collection=collection,
        embedder=lambda _texts: [[0.1]],
        semantic_fallback=True,
    )
    input_data = CurriculumSearchInput.from_payload(
        {
            "query": "数据结构是必修课吗",
            "major": "computer-science",
            "cohort": "2026",
            "version": "2026.1",
            "top_k": 5,
        }
    )

    result = index.search(input_data)

    assert result["match_count"] == 1
    assert result["sources"][0]["page"] == 8
    assert collection.last_query["where"] == {
        "$and": [
            {"major": "computer-science"},
            {"cohort": "2026"},
            {"version": "2026.1"},
        ]
    }


def test_search_rejects_an_empty_curriculum_collection(tmp_path: Path) -> None:
    index = CurriculumSearchIndex(tmp_path, collection=FakeCollection(), embedder=lambda _texts: [[0.1]])

    with pytest.raises(CurriculumSearchError) as error:
        index.search(CurriculumSearchInput.from_payload({"query": "毕业要求"}))

    assert error.value.code == "KNOWLEDGE_BASE_EMPTY"


def test_index_rejects_sources_without_text(tmp_path: Path) -> None:
    index = CurriculumSearchIndex(tmp_path, collection=FakeCollection(), embedder=lambda _texts: [])

    with pytest.raises(CurriculumSearchError) as error:
        index.index_sources(_document(), [{"content": "", "page": 1}])

    assert error.value.code == "NO_EVIDENCE"


def test_search_handler_returns_shared_sources(monkeypatch: pytest.MonkeyPatch) -> None:
    import server as course_server

    def local_search(_input_data: CurriculumSearchInput) -> dict[str, Any]:
        return {
            "query": "毕业要求",
            "filters": {"major": "computer-science"},
            "search_mode": "lexical",
            "match_count": 1,
            "top_score": 0.91,
            "sources": [
                {
                    "document": "培养方案.pdf",
                    "section": None,
                    "page": 3,
                    "content": "学生应完成培养方案规定学分。",
                    "chunk_index": 1,
                    "score": 0.91,
                }
            ],
        }

    monkeypatch.setattr(course_server, "_search_portable_curriculum_evidence", local_search)

    response = handle_curriculum_search({"query": "毕业要求", "major": "computer-science"})

    assert response["ok"] is True
    assert response["data"]["match_count"] == 1
    assert response["sources"][0]["page"] == 3


def test_registered_search_tool_routes_to_the_search_handler(monkeypatch: pytest.MonkeyPatch) -> None:
    import server as course_server

    observed: dict[str, Any] = {}

    def fake_handler(payload: dict[str, Any]) -> dict[str, Any]:
        observed.update(payload)
        return {"ok": True, "meta": {"tool": "curriculum_search"}}

    monkeypatch.setattr(course_server, "handle_curriculum_search", fake_handler)

    response = anyio.run(
        course_server.curriculum_search,
        "毕业要求",
        "computer-science",
        "2026",
        "2026.1",
        "curriculum-cs-2026",
        5,
    )

    assert response["meta"]["tool"] == "curriculum_search"
    assert observed == {
        "query": "毕业要求",
        "major": "computer-science",
        "cohort": "2026",
        "version": "2026.1",
        "document_id": "curriculum-cs-2026",
        "top_k": 5,
    }


def test_search_handler_returns_no_evidence_as_a_structured_error(monkeypatch: pytest.MonkeyPatch) -> None:
    import server as course_server

    def local_search(_input_data: CurriculumSearchInput) -> dict[str, Any]:
        return {
            "query": "不存在的要求",
            "filters": {},
            "search_mode": "lexical",
            "match_count": 0,
            "top_score": 0.12,
            "sources": [],
        }

    monkeypatch.setattr(course_server, "_search_portable_curriculum_evidence", local_search)

    response = handle_curriculum_search({"query": "不存在的要求"})

    assert response["ok"] is False
    assert response["error"]["code"] == "NO_EVIDENCE"
    assert response["error"]["details"]["top_score"] == 0.12


def test_chroma_curriculum_collection_persists_and_remains_searchable(tmp_path: Path) -> None:
    persist_dir = tmp_path / "vector-index"
    embedder = lambda texts: [[1.0, 0.0] for _text in texts]
    first = CurriculumSearchIndex(persist_dir, embedder=embedder)
    first.index_sources(
        _document(),
        [{"content": "数据结构为专业必修课。", "page": 8, "chunk_index": 0}],
    )

    reopened = CurriculumSearchIndex(persist_dir, embedder=embedder)
    result = reopened.search(
        CurriculumSearchInput.from_payload(
            {"query": "数据结构", "major": "computer-science", "cohort": "2026"}
        )
    )

    assert result["match_count"] == 1
    assert result["sources"][0]["document"] == "培养方案.pdf"
    reopened.clear()
    assert reopened.collection.count() == 0
