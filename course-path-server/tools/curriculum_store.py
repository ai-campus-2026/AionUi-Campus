"""Managed persistent storage for shared curriculum-plan documents.

The store is deliberately separate from ``data/course_catalog.json``.  It
keeps shared curriculum source files and their extracted catalog records, but
never stores student transcripts or completed-course inputs.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import UUID


class CurriculumStoreError(Exception):
    """A recoverable error from the managed curriculum knowledge base."""

    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


class CurriculumKnowledgeStore:
    """Store shared curriculum documents in one isolated knowledge-base area."""

    def __init__(self, base_dir: Path) -> None:
        self.base_dir = base_dir
        self.documents_dir = base_dir / "documents"
        self.catalogs_dir = base_dir / "catalogs"
        self.evidence_dir = base_dir / "evidence"
        self.index_path = base_dir / "index.json"

    def store_source(
        self,
        *,
        attachment_path: str,
        attachment: dict[str, Any],
        major: str,
        cohort: str,
        version: str,
    ) -> tuple[dict[str, Any], bool]:
        """Copy one checked shared curriculum file into the managed partition.

        The source file is copied; it is never moved, edited, or deleted.  A
        content hash prevents repeated uploads for the same curriculum version
        from creating duplicate stored records.
        """
        if attachment.get("status") != "VALID":
            raise CurriculumStoreError("INVALID_ARGUMENT", "附件不可存入培养方案库", {"reason": "attachment_invalid"})
        digest = attachment.get("sha256")
        if not isinstance(digest, str) or not digest:
            raise CurriculumStoreError("INTERNAL_ERROR", "附件校验信息无效")

        source = Path(attachment_path).resolve(strict=True)
        self._ensure_layout()
        index = self._read_index()
        existing = next(
            (
                entry
                for entry in index["documents"]
                if entry["sha256"] == digest
                and entry["major"] == major
                and entry["cohort"] == cohort
                and entry["version"] == version
            ),
            None,
        )
        if existing is not None:
            return dict(existing), False

        document_id = _document_id(major, cohort, version, digest)
        stored_name = f"{document_id}{source.suffix.lower()}"
        destination = self.documents_dir / stored_name
        try:
            shutil.copyfile(source, destination)
        except OSError as error:
            raise CurriculumStoreError("INTERNAL_ERROR", "培养方案文件存储失败") from error

        entry = {
            "document_id": document_id,
            "knowledge_base": "curriculum",
            "major": major,
            "cohort": cohort,
            "version": version,
            "original_filename": source.name,
            "stored_file": f"documents/{stored_name}",
            "sha256": digest,
            "stored_at": _now(),
            "storage_status": "SOURCE_STORED",
            "processing_status": "SOURCE_STORED",
            "extraction_status": "EXTRACTION_PENDING",
            "catalog_status": None,
            "review_status": None,
            "auto_verified": False,
            "catalog_file": None,
            "extraction_file": None,
            "rag_status": "NOT_INDEXED",
            "rag_chunk_count": 0,
            "evidence_status": "NOT_INDEXED",
            "evidence_chunk_count": 0,
        }
        index["documents"].append(entry)
        self._write_index(index)
        return dict(entry), True

    def save_extraction_result(self, document_id: str, result: dict[str, Any]) -> dict[str, Any]:
        """Store interpretation evidence and any catalog draft without publishing rules."""
        self._ensure_layout()
        index = self._read_index()
        entry = self._find_entry(index, document_id)
        catalog = result.get("catalog")
        review = result.get("review")
        summary = result.get("extraction_summary")
        sources = result.get("sources")
        catalog_path = self.catalogs_dir / f"{document_id}.json"
        detail = {
            "document_id": document_id,
            "stored_at": _now(),
            "catalog": catalog,
            "validation": result.get("validation"),
            "review": review,
            "extraction_summary": summary,
            "sources": sources if isinstance(sources, list) else [],
            "course_line_candidates": result.get("course_line_candidates", []),
        }
        self._write_json(catalog_path, detail)

        relative_result_path = f"catalogs/{document_id}.json"
        entry["extraction_file"] = relative_result_path
        entry["catalog_file"] = relative_result_path if isinstance(catalog, dict) else None
        entry["catalog_status"] = catalog.get("data_status") if isinstance(catalog, dict) else None
        entry["review_status"] = review.get("review_status") if isinstance(review, dict) else None
        entry["auto_verified"] = bool(review.get("auto_verified")) if isinstance(review, dict) else False

        summary_status = summary.get("status") if isinstance(summary, dict) else None
        if summary_status == "EXTRACTION_FAILED":
            entry["processing_status"] = "EXTRACTION_FAILED"
            entry["extraction_status"] = "EXTRACTION_FAILED"
        elif summary_status == "EXTRACTION_PARTIAL":
            entry["processing_status"] = "EXTRACTION_PARTIAL"
            entry["extraction_status"] = "EXTRACTION_PARTIAL"
        elif summary_status == "EXTRACTION_COMPLETE":
            entry["processing_status"] = "AUTO_VERIFIED" if entry["auto_verified"] else "REVIEW_FAILED"
            entry["extraction_status"] = "AUTO_VERIFIED" if entry["auto_verified"] else "REVIEW_FAILED"
        else:
            entry["processing_status"] = "AUTO_VERIFIED" if entry["auto_verified"] else "REVIEW_FAILED"
            entry["extraction_status"] = "AUTO_VERIFIED" if entry["auto_verified"] else "REVIEW_FAILED"
        entry.pop("last_error_code", None)
        entry.pop("last_error_stage", None)
        entry.pop("last_error_reason", None)
        self._write_index(index)
        return dict(entry)

    def record_rag_index(
        self,
        document_id: str,
        chunk_count: int,
        embedding_model: str,
    ) -> dict[str, Any]:
        """Record successful indexing without exposing vector-store paths."""
        self._ensure_layout()
        index = self._read_index()
        entry = self._find_entry(index, document_id)
        entry["rag_status"] = "INDEXED"
        entry["rag_chunk_count"] = chunk_count
        entry["rag_embedding_model"] = embedding_model
        entry["rag_indexed_at"] = _now()
        entry.pop("rag_error_code", None)
        entry.pop("rag_error_reason", None)
        self._write_index(index)
        return dict(entry)

    def record_rag_failure(
        self,
        document_id: str,
        error_code: str,
        *,
        reason: str | None = None,
    ) -> dict[str, Any]:
        """Record a safe indexing failure while retaining the source document."""
        self._ensure_layout()
        index = self._read_index()
        entry = self._find_entry(index, document_id)
        entry["rag_status"] = "INDEX_FAILED"
        entry["rag_chunk_count"] = 0
        entry["rag_error_code"] = error_code
        entry.pop("rag_error_reason", None)
        if reason:
            entry["rag_error_reason"] = reason
        self._write_index(index)
        return dict(entry)

    def record_extraction_failure(
        self,
        document_id: str,
        error_code: str,
        *,
        error_stage: str | None = None,
        error_reason: Any | None = None,
    ) -> dict[str, Any]:
        """Keep the source document while recording a safe, retryable failure state."""
        self._ensure_layout()
        index = self._read_index()
        entry = self._find_entry(index, document_id)
        entry["processing_status"] = "EXTRACTION_FAILED"
        entry["extraction_status"] = "EXTRACTION_FAILED"
        entry["last_error_code"] = error_code
        entry.pop("last_error_stage", None)
        entry.pop("last_error_reason", None)
        if error_stage is not None:
            entry["last_error_stage"] = error_stage
        if isinstance(error_reason, str) and error_reason:
            entry["last_error_reason"] = error_reason
        self._write_index(index)
        return dict(entry)

    def load_source_for_retry(self, document_id: str) -> tuple[dict[str, Any], Path, dict[str, Any]]:
        """Return a hash-checked stored source for internal retry processing only.

        The returned path is deliberately an internal value: callers must never
        expose it in an MCP response or accept it from an MCP request.
        """
        self._ensure_layout()
        index = self._read_index()
        entry = self._find_entry(index, document_id)
        stored_file = entry.get("stored_file")
        if not isinstance(stored_file, str):
            raise CurriculumStoreError("INTERNAL_ERROR", "培养方案文件记录无效")
        try:
            source = (self.base_dir / stored_file).resolve(strict=True)
            source.relative_to(self.documents_dir.resolve())
        except (OSError, ValueError) as error:
            raise CurriculumStoreError("INTERNAL_ERROR", "培养方案文件不可读取") from error
        if not source.is_file():
            raise CurriculumStoreError("INTERNAL_ERROR", "培养方案文件不可读取")
        expected_digest = entry.get("sha256")
        if not isinstance(expected_digest, str) or _sha256(source) != expected_digest:
            raise CurriculumStoreError("INTERNAL_ERROR", "培养方案文件校验失败")
        try:
            size_bytes = source.stat().st_size
        except OSError as error:
            raise CurriculumStoreError("INTERNAL_ERROR", "培养方案文件不可读取") from error
        return (
            dict(entry),
            source,
            {
                "status": "VALID",
                "extension": source.suffix.lower(),
                "size_bytes": size_bytes,
                "sha256": expected_digest,
            },
        )

    def list_documents(
        self,
        *,
        major: str | None = None,
        cohort: str | None = None,
        version: str | None = None,
    ) -> list[dict[str, Any]]:
        """List shared curriculum records without exposing their original paths."""
        self._ensure_layout()
        entries = self._read_index()["documents"]
        return [
            dict(entry)
            for entry in entries
            if (major is None or entry["major"] == major)
            and (cohort is None or entry["cohort"] == cohort)
            and (version is None or entry["version"] == version)
        ]

    def load_extraction_result(self, document_id: str) -> tuple[dict[str, Any], dict[str, Any] | None]:
        """Load one stored interpretation without exposing a local filesystem path."""
        self._ensure_layout()
        index = self._read_index()
        entry = self._find_entry(index, document_id)
        extraction_file = entry.get("extraction_file") or entry.get("catalog_file")
        if extraction_file is None:
            return dict(entry), None
        if not isinstance(extraction_file, str):
            raise CurriculumStoreError("INTERNAL_ERROR", "培养方案解析记录无效")
        try:
            result_path = (self.base_dir / extraction_file).resolve(strict=True)
            result_path.relative_to(self.catalogs_dir.resolve())
            with result_path.open("r", encoding="utf-8") as result_file:
                result = json.load(result_file)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            raise CurriculumStoreError("INTERNAL_ERROR", "培养方案解析记录不可读取") from error
        if not isinstance(result, dict):
            raise CurriculumStoreError("INTERNAL_ERROR", "培养方案解析记录无效")
        return dict(entry), result

    def save_evidence(self, document_id: str, sources: list[dict[str, Any]]) -> dict[str, Any]:
        """Persist bounded page chunks for fast local retrieval without Chroma."""
        self._ensure_layout()
        index = self._read_index()
        entry = self._find_entry(index, document_id)
        safe_sources = [
            {
                "document": str(source.get("document") or entry["original_filename"]),
                "section": source.get("section") if isinstance(source.get("section"), str) else None,
                "page": source.get("page") if isinstance(source.get("page"), int) else None,
                "content": str(source.get("content") or ""),
                "chunk_index": source.get("chunk_index") if isinstance(source.get("chunk_index"), int) else position,
            }
            for position, source in enumerate(sources)
            if isinstance(source, dict) and str(source.get("content") or "").strip()
        ]
        evidence_path = self.evidence_dir / f"{document_id}.json"
        self._write_json(
            evidence_path,
            {
                "schema_version": "0.1",
                "document_id": document_id,
                "sources": safe_sources,
            },
        )
        entry["evidence_status"] = "INDEXED"
        entry["evidence_chunk_count"] = len(safe_sources)
        entry["evidence_file"] = f"evidence/{document_id}.json"
        self._write_index(index)
        return dict(entry)

    def load_evidence(self, document_id: str) -> list[dict[str, Any]] | None:
        """Load the local JSON evidence cache without opening the vector store."""
        self._ensure_layout()
        index = self._read_index()
        entry = self._find_entry(index, document_id)
        evidence_file = entry.get("evidence_file")
        if not isinstance(evidence_file, str):
            return None
        try:
            evidence_path = (self.base_dir / evidence_file).resolve(strict=True)
            evidence_path.relative_to(self.evidence_dir.resolve())
            payload = json.loads(evidence_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, json.JSONDecodeError) as error:
            raise CurriculumStoreError("INTERNAL_ERROR", "培养方案证据索引不可读取") from error
        sources = payload.get("sources") if isinstance(payload, dict) else None
        if not isinstance(sources, list) or not all(isinstance(source, dict) for source in sources):
            raise CurriculumStoreError("INTERNAL_ERROR", "培养方案证据索引格式无效")
        return sources

    def clear(self, *, confirm: bool) -> int:
        """Clear only this managed curriculum partition after explicit confirmation."""
        if confirm is not True:
            raise CurriculumStoreError("INVALID_ARGUMENT", "清空培养方案库需要确认", {"reason": "confirm_must_be_true"})

        self._ensure_layout()
        count = len(self._read_index()["documents"])
        for directory in (self.documents_dir, self.catalogs_dir, self.evidence_dir):
            shutil.rmtree(directory, ignore_errors=True)
        self._ensure_layout()
        self._write_index(self._empty_index())
        return count

    def _ensure_layout(self) -> None:
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.documents_dir.mkdir(exist_ok=True)
        self.catalogs_dir.mkdir(exist_ok=True)
        self.evidence_dir.mkdir(exist_ok=True)
        if not self.index_path.exists():
            self._write_index(self._empty_index())

    def _empty_index(self) -> dict[str, Any]:
        return {
            "schema_version": "0.1",
            "knowledge_base": "curriculum",
            "last_updated": _now(),
            "documents": [],
        }

    def _read_index(self) -> dict[str, Any]:
        try:
            with self.index_path.open("r", encoding="utf-8") as index_file:
                index = json.load(index_file)
        except (OSError, json.JSONDecodeError) as error:
            raise CurriculumStoreError("INTERNAL_ERROR", "培养方案索引不可读取") from error
        if not isinstance(index.get("documents"), list):
            raise CurriculumStoreError("INTERNAL_ERROR", "培养方案索引格式无效")
        for entry in index["documents"]:
            if not isinstance(entry, dict):
                raise CurriculumStoreError("INTERNAL_ERROR", "培养方案索引格式无效")
            entry.setdefault("storage_status", "SOURCE_STORED")
            entry.setdefault("rag_status", "NOT_INDEXED")
            entry.setdefault("rag_chunk_count", 0)
            entry.setdefault("evidence_status", "NOT_INDEXED")
            entry.setdefault("evidence_chunk_count", 0)
            entry.setdefault("extraction_status", _legacy_extraction_status(entry.get("processing_status")))
        return index

    def _find_entry(self, index: dict[str, Any], document_id: str) -> dict[str, Any]:
        entry = next((item for item in index["documents"] if item["document_id"] == document_id), None)
        if entry is None:
            raise CurriculumStoreError("DOCUMENT_NOT_FOUND", "未找到培养方案文档", {"document_id": document_id})
        return entry

    def _write_index(self, index: dict[str, Any]) -> None:
        index["last_updated"] = _now()
        self._write_json(self.index_path, index)

    def _write_json(self, destination: Path, data: dict[str, Any]) -> None:
        temporary_path = destination.with_suffix(f"{destination.suffix}.{os.getpid()}.tmp")
        try:
            with temporary_path.open("w", encoding="utf-8") as output:
                json.dump(data, output, ensure_ascii=False, indent=2)
            os.replace(temporary_path, destination)
        except OSError as error:
            temporary_path.unlink(missing_ok=True)
            raise CurriculumStoreError("INTERNAL_ERROR", "培养方案数据写入失败") from error


class AnonymousProgressStore:
    """Persist only course status codes in a partition separate from curriculum documents."""

    def __init__(self, base_dir: Path) -> None:
        self.base_dir = base_dir

    def load(self, profile_id: str, document_id: str) -> dict[str, Any]:
        destination = self._path(profile_id, document_id)
        if not destination.exists():
            return {"profile_id": profile_id, "document_id": document_id, "course_statuses": {}, "updated_at": None}
        try:
            with destination.open(encoding="utf-8") as source:
                value = json.load(source)
        except (OSError, json.JSONDecodeError) as error:
            raise CurriculumStoreError("PROGRESS_UNREADABLE", "修读状态不可读取") from error
        statuses = value.get("course_statuses") if isinstance(value, dict) else None
        if not isinstance(statuses, dict) or not all(
            isinstance(code, str) and status in {"passed", "failed"}
            for code, status in statuses.items()
        ):
            raise CurriculumStoreError("PROGRESS_INVALID", "修读状态格式无效")
        return value

    def save(
        self,
        profile_id: str,
        document_id: str,
        statuses: dict[str, str],
        known_codes: set[str],
    ) -> dict[str, Any]:
        destination = self._path(profile_id, document_id)
        if not isinstance(statuses, dict) or any(
            code not in known_codes or status not in {"passed", "failed", "not_taken"}
            for code, status in statuses.items()
        ):
            raise CurriculumStoreError("INVALID_ARGUMENT", "修读状态包含未知课程或状态")
        data = {
            "schema_version": "0.1",
            "profile_id": profile_id,
            "document_id": document_id,
            "course_statuses": {code: status for code, status in statuses.items() if status != "not_taken"},
            "updated_at": _now(),
        }
        temporary = destination.with_suffix(f".{os.getpid()}.tmp")
        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
            with temporary.open("w", encoding="utf-8") as output:
                json.dump(data, output, ensure_ascii=False, indent=2)
            os.replace(temporary, destination)
        except OSError as error:
            temporary.unlink(missing_ok=True)
            raise CurriculumStoreError("INTERNAL_ERROR", "修读状态保存失败") from error
        return data

    def clear(self, profile_id: str, document_id: str) -> bool:
        destination = self._path(profile_id, document_id)
        existed = destination.exists()
        try:
            destination.unlink(missing_ok=True)
        except OSError as error:
            raise CurriculumStoreError("INTERNAL_ERROR", "修读状态清除失败") from error
        return existed

    def _path(self, profile_id: str, document_id: str) -> Path:
        try:
            if str(UUID(profile_id)) != profile_id:
                raise ValueError("profile_id_not_canonical")
        except (ValueError, AttributeError, TypeError) as error:
            raise CurriculumStoreError("INVALID_ARGUMENT", "匿名档案编号无效") from error
        if not isinstance(document_id, str) or not re.fullmatch(r"curriculum-[\w-]+", document_id):
            raise CurriculumStoreError("INVALID_ARGUMENT", "培养方案编号无效")
        digest = hashlib.sha256(document_id.encode("utf-8")).hexdigest()
        return self.base_dir / profile_id / f"{digest}.json"


def _document_id(major: str, cohort: str, version: str, digest: str) -> str:
    return "-".join(("curriculum", _slug(major), _slug(cohort), _slug(version), digest[:12]))


def _slug(value: str) -> str:
    normalized = re.sub(r"[^\w]+", "-", value.strip(), flags=re.UNICODE).strip("-_").lower()
    return normalized or "unspecified"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source_file:
            while chunk := source_file.read(64 * 1024):
                digest.update(chunk)
    except OSError as error:
        raise CurriculumStoreError("INTERNAL_ERROR", "培养方案文件不可读取") from error
    return digest.hexdigest()


def _legacy_extraction_status(processing_status: Any) -> str:
    if processing_status in {
        "EXTRACTION_PENDING",
        "EXTRACTION_FAILED",
        "EXTRACTION_PARTIAL",
        "AUTO_VERIFIED",
        "REVIEW_FAILED",
    }:
        return str(processing_status)
    return "EXTRACTION_PENDING"
