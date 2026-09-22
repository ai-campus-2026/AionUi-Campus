"""Isolated vector index for shared curriculum-plan evidence."""

from __future__ import annotations

import hashlib
import json
import os
import re
import socket
import ssl
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, Protocol

from schemas.curriculum_search import CurriculumSearchInput


COLLECTION_NAME = "curriculum_documents"
EMBEDDING_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings"
DEFAULT_EMBEDDING_MODEL = "text-embedding-v4"
EMBEDDING_BATCH_SIZE = 10
MAX_EMBEDDING_ATTEMPTS = 2
EMBEDDING_TIMEOUT_SECONDS = 45
DEFAULT_SCORE_THRESHOLD = 0.3


def configured_embedding_model() -> str:
    """Return the non-secret model identifier used for this local index."""
    return os.getenv("EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL).strip() or DEFAULT_EMBEDDING_MODEL


def configured_semantic_fallback() -> bool:
    """Keep remote query embeddings opt-in so ordinary searches cannot stall."""
    value = os.getenv("CURRICULUM_SEMANTIC_FALLBACK", "false").strip().casefold()
    return value in {"1", "true", "yes", "on"}


class _Collection(Protocol):
    metadata: Mapping[str, Any] | None

    def count(self) -> int: ...

    def upsert(
        self,
        *,
        ids: list[str],
        embeddings: list[list[float]],
        metadatas: list[dict[str, Any]],
        documents: list[str],
    ) -> Any: ...

    def query(self, **kwargs: Any) -> Mapping[str, Any]: ...

    def get(self, **kwargs: Any) -> Mapping[str, Any]: ...

    def delete(self, **kwargs: Any) -> Any: ...


class CurriculumSearchError(Exception):
    """A safe failure from curriculum indexing or retrieval."""

    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


class CurriculumSearchIndex:
    """Persist and search only curriculum evidence in one Chroma collection."""

    def __init__(
        self,
        persist_dir: Path,
        *,
        embedding_model: str | None = None,
        score_threshold: float = DEFAULT_SCORE_THRESHOLD,
        collection: _Collection | None = None,
        embedder: Callable[[list[str]], list[list[float]]] | None = None,
        semantic_fallback: bool | None = None,
    ) -> None:
        self.persist_dir = persist_dir
        self.embedding_model = embedding_model or configured_embedding_model()
        self.score_threshold = score_threshold
        self.semantic_fallback = configured_semantic_fallback() if semantic_fallback is None else semantic_fallback
        self._embedder = embedder or self._embed_dashscope
        self.collection = collection or self._open_collection()
        stored_model = (self.collection.metadata or {}).get("embedding_model")
        if stored_model and stored_model != self.embedding_model:
            raise CurriculumSearchError(
                "EMBEDDING_FAILED",
                "培养方案向量模型与现有索引不一致",
                {"reason": "embedding_model_mismatch"},
            )

    def index_sources(self, document: Mapping[str, Any], sources: list[dict[str, Any]]) -> int:
        """Replace one document's indexed chunks after all embeddings succeed."""
        document_id = document.get("document_id")
        if not isinstance(document_id, str) or not document_id:
            raise CurriculumSearchError("INVALID_ARGUMENT", "培养方案索引信息无效", {"reason": "document_id_required"})

        records = _index_records(document, sources)
        if not records:
            raise CurriculumSearchError("NO_EVIDENCE", "培养方案中没有可索引文本", {"reason": "document_text_empty"})

        texts = [record[1] for record in records]
        embeddings: list[list[float]] = []
        for offset in range(0, len(texts), EMBEDDING_BATCH_SIZE):
            embeddings.extend(self._embedder(texts[offset : offset + EMBEDDING_BATCH_SIZE]))
        if len(embeddings) != len(records):
            raise CurriculumSearchError("EMBEDDING_FAILED", "培养方案向量结果数量无效", {})

        self.collection.delete(where={"document_id": document_id})
        self.collection.upsert(
            ids=[record[0] for record in records],
            embeddings=embeddings,
            metadatas=[record[2] for record in records],
            documents=texts,
        )
        return len(records)

    def search(self, input_data: CurriculumSearchInput) -> dict[str, Any]:
        """Return local lexical evidence first, with semantic retrieval as fallback."""
        if self.collection.count() == 0:
            raise CurriculumSearchError("KNOWLEDGE_BASE_EMPTY", "培养方案知识库为空", {})

        filters = _filters(input_data)
        local_result = self._search_local(input_data.query, filters, input_data.top_k)
        if local_result["sources"]:
            return {
                "query": input_data.query,
                "filters": filters,
                "search_mode": "lexical",
                "match_count": len(local_result["sources"]),
                "top_score": local_result["top_score"],
                "sources": local_result["sources"],
            }

        if not self.semantic_fallback:
            return {
                "query": input_data.query,
                "filters": filters,
                "search_mode": "lexical",
                "match_count": 0,
                "top_score": None,
                "sources": [],
            }

        query_embedding = self._embedder([input_data.query])[0]
        kwargs: dict[str, Any] = {
            "query_embeddings": [query_embedding],
            "n_results": min(input_data.top_k, self.collection.count()),
            "include": ["documents", "metadatas", "distances"],
        }
        where = _where(filters)
        if where is not None:
            kwargs["where"] = where
        raw = self.collection.query(**kwargs)

        metadatas = (raw.get("metadatas") or [[]])[0]
        documents = (raw.get("documents") or [[]])[0]
        distances = (raw.get("distances") or [[]])[0]
        sources: list[dict[str, Any]] = []
        candidates: list[float] = []
        for metadata, content, distance in zip(metadatas, documents, distances):
            score = round(1.0 - float(distance), 4)
            candidates.append(score)
            if score < self.score_threshold:
                continue
            sources.append(
                {
                    "document": metadata.get("original_filename"),
                    "section": None,
                    "page": metadata.get("page"),
                    "content": content,
                    "chunk_index": metadata.get("chunk_index"),
                    "score": score,
                }
            )
        sources.sort(key=lambda item: item["score"], reverse=True)
        return {
            "query": input_data.query,
            "filters": filters,
            "search_mode": "semantic",
            "match_count": len(sources),
            "top_score": sources[0]["score"] if sources else (max(candidates) if candidates else None),
            "sources": sources,
        }

    def _search_local(self, query: str, filters: Mapping[str, str], top_k: int) -> dict[str, Any]:
        """Rank stored chunks locally so obvious questions need no model call."""
        kwargs: dict[str, Any] = {"include": ["documents", "metadatas"]}
        where = _where(filters)
        if where is not None:
            kwargs["where"] = where
        raw = self.collection.get(**kwargs)
        metadatas = raw.get("metadatas") or []
        documents = raw.get("documents") or []
        sources: list[dict[str, Any]] = []
        for metadata, content in zip(metadatas, documents):
            if not isinstance(metadata, Mapping) or not isinstance(content, str):
                continue
            sources.append(
                {
                    "document": metadata.get("original_filename"),
                    "section": None,
                    "page": metadata.get("page"),
                    "content": content,
                    "chunk_index": metadata.get("chunk_index"),
                }
            )
        return rank_lexical_sources(query, sources, top_k=top_k, score_threshold=self.score_threshold)

    def delete_document(self, document_id: str) -> None:
        """Delete only chunks belonging to one curriculum document."""
        self.collection.delete(where={"document_id": document_id})

    def clear(self) -> None:
        """Clear only the curriculum collection without touching other domains."""
        self.collection.delete(where={"knowledge_base": "curriculum"})

    def _open_collection(self) -> _Collection:
        try:
            import chromadb
            from chromadb.config import Settings
        except ImportError as error:
            raise CurriculumSearchError(
                "INTERNAL_ERROR",
                "培养方案向量组件未安装",
                {"reason": "chromadb_not_installed"},
            ) from error
        self.persist_dir.mkdir(parents=True, exist_ok=True)
        client = chromadb.PersistentClient(
            path=str(self.persist_dir),
            settings=Settings(anonymized_telemetry=False),
        )
        return client.get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={"hnsw:space": "cosine", "embedding_model": self.embedding_model},
        )

    def _embed_dashscope(self, texts: list[str]) -> list[list[float]]:
        api_key = os.getenv("DASHSCOPE_API_KEY")
        if not api_key:
            raise CurriculumSearchError("EMBEDDING_FAILED", "未配置本机向量模型凭证", {"reason": "api_key_missing"})

        body = json.dumps({"model": self.embedding_model, "input": texts}, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            EMBEDDING_URL,
            data=body,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        last_error: CurriculumSearchError | None = None
        for attempt in range(1, MAX_EMBEDDING_ATTEMPTS + 1):
            try:
                with urllib.request.urlopen(request, timeout=EMBEDDING_TIMEOUT_SECONDS) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                data = payload.get("data")
                if not isinstance(data, list):
                    raise CurriculumSearchError("EMBEDDING_FAILED", "向量模型响应格式无效", {})
                ordered = sorted(data, key=lambda item: item.get("index", 0))
                embeddings = [item.get("embedding") for item in ordered]
                if not all(isinstance(item, list) and item for item in embeddings):
                    raise CurriculumSearchError("EMBEDDING_FAILED", "向量模型响应格式无效", {})
                return embeddings
            except urllib.error.HTTPError as error:
                last_error = CurriculumSearchError(
                    "EMBEDDING_FAILED",
                    "向量模型请求失败",
                    {"status": error.code, "attempts": attempt},
                )
                if error.code not in {408, 429, 500, 502, 503, 504}:
                    raise last_error from error
            except (TimeoutError, urllib.error.URLError, socket.timeout, ssl.SSLError, OSError) as error:
                last_error = CurriculumSearchError(
                    "EMBEDDING_FAILED",
                    "向量模型请求失败",
                    {"reason": _network_reason(error), "attempts": attempt},
                )
            except (json.JSONDecodeError, CurriculumSearchError) as error:
                if isinstance(error, CurriculumSearchError):
                    raise
                raise CurriculumSearchError("EMBEDDING_FAILED", "向量模型响应格式无效", {}) from error
            if attempt < MAX_EMBEDDING_ATTEMPTS:
                time.sleep(float(2 ** (attempt - 1)))
        raise last_error or CurriculumSearchError("EMBEDDING_FAILED", "向量模型请求失败", {})


def _index_records(
    document: Mapping[str, Any], sources: list[dict[str, Any]]
) -> list[tuple[str, str, dict[str, Any]]]:
    records: list[tuple[str, str, dict[str, Any]]] = []
    document_id = str(document["document_id"])
    for fallback_index, source in enumerate(sources):
        content = source.get("content")
        if not isinstance(content, str) or not content.strip():
            continue
        text = content.strip()
        page = source.get("page")
        chunk_index = source.get("chunk_index")
        if not isinstance(chunk_index, int) or chunk_index < 0:
            chunk_index = fallback_index
        digest = hashlib.sha256(f"{document_id}|{page}|{chunk_index}|{text}".encode("utf-8")).hexdigest()
        metadata: dict[str, Any] = {
            "knowledge_base": "curriculum",
            "document_id": document_id,
            "major": str(document.get("major", "")),
            "cohort": str(document.get("cohort", "")),
            "version": str(document.get("version", "")),
            "original_filename": str(document.get("original_filename", "")),
            "chunk_index": chunk_index,
        }
        if isinstance(page, int) and page > 0:
            metadata["page"] = page
        records.append((f"{document_id[:24]}-{digest[:32]}", text, metadata))
    return records


def _filters(input_data: CurriculumSearchInput) -> dict[str, str]:
    return {
        key: value
        for key, value in {
            "major": input_data.major,
            "cohort": input_data.cohort,
            "version": input_data.version,
            "document_id": input_data.document_id,
        }.items()
        if value is not None
    }


def _where(filters: Mapping[str, str]) -> dict[str, Any] | None:
    clauses = [{key: value} for key, value in filters.items()]
    if not clauses:
        return None
    if len(clauses) == 1:
        return clauses[0]
    return {"$and": clauses}


def _network_reason(error: BaseException) -> str:
    reason = getattr(error, "reason", error)
    if isinstance(reason, socket.gaierror):
        return "dns_resolution_failed"
    if isinstance(reason, ssl.SSLError):
        return "tls_failed"
    if isinstance(reason, (TimeoutError, socket.timeout)):
        return "timeout"
    if isinstance(reason, ConnectionRefusedError):
        return "connection_refused"
    return "connection_failed"


def _lexical_score(query: str, content: str) -> float:
    """Score query coverage using ASCII words and Chinese character bigrams."""
    query_terms = _lexical_terms(query)
    if not query_terms:
        return 0.0
    content_terms = _lexical_terms(content)
    matched = query_terms & content_terms
    if not matched:
        return 0.0
    denominator = min(len(query_terms), 5)
    return round(min(1.0, len(matched) / denominator), 4)


def rank_lexical_sources(
    query: str,
    sources: list[dict[str, Any]],
    *,
    top_k: int,
    score_threshold: float = DEFAULT_SCORE_THRESHOLD,
) -> dict[str, Any]:
    """Rank portable JSON evidence without opening a vector database."""
    candidates: list[dict[str, Any]] = []
    for source in sources:
        content = source.get("content")
        if not isinstance(content, str):
            continue
        score = _lexical_score(query, content)
        if score < score_threshold:
            continue
        candidates.append({**source, "score": score})
    candidates.sort(key=lambda item: item["score"], reverse=True)
    selected = candidates[:top_k]
    return {
        "top_score": selected[0]["score"] if selected else None,
        "sources": selected,
    }


def _lexical_terms(text: str) -> set[str]:
    """Create bounded language-neutral terms without external tokenizers."""
    normalized = text.casefold()
    terms = set(re.findall(r"[a-z0-9][a-z0-9_-]+", normalized))
    for sequence in re.findall(r"[\u3400-\u9fff]+", normalized):
        terms.update(sequence[index : index + 2] for index in range(len(sequence) - 1))
    return terms
