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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


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
            "processing_status": "SOURCE_STORED",
            "catalog_status": None,
            "review_status": None,
            "auto_verified": False,
            "catalog_file": None,
        }
        index["documents"].append(entry)
        self._write_index(index)
        return dict(entry), True

    def save_extraction_result(self, document_id: str, result: dict[str, Any]) -> dict[str, Any]:
        """Store a model-extracted catalog without publishing it as course rules."""
        self._ensure_layout()
        index = self._read_index()
        entry = self._find_entry(index, document_id)
        catalog = result["catalog"]
        review = result["review"]
        catalog_path = self.catalogs_dir / f"{document_id}.json"
        detail = {
            "document_id": document_id,
            "stored_at": _now(),
            "catalog": catalog,
            "validation": result["validation"],
            "review": review,
        }
        self._write_json(catalog_path, detail)

        entry["catalog_file"] = f"catalogs/{document_id}.json"
        entry["catalog_status"] = catalog["data_status"]
        entry["review_status"] = review["review_status"]
        entry["auto_verified"] = review["auto_verified"]
        entry["processing_status"] = "AUTO_VERIFIED" if review["auto_verified"] else "REVIEW_FAILED"
        self._write_index(index)
        return dict(entry)

    def record_extraction_failure(self, document_id: str, error_code: str) -> dict[str, Any]:
        """Keep the source document while recording a safe, retryable failure state."""
        self._ensure_layout()
        index = self._read_index()
        entry = self._find_entry(index, document_id)
        entry["processing_status"] = "EXTRACTION_FAILED"
        entry["last_error_code"] = error_code
        self._write_index(index)
        return dict(entry)

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

    def clear(self, *, confirm: bool) -> int:
        """Clear only this managed curriculum partition after explicit confirmation."""
        if confirm is not True:
            raise CurriculumStoreError("INVALID_ARGUMENT", "清空培养方案库需要确认", {"reason": "confirm_must_be_true"})

        self._ensure_layout()
        count = len(self._read_index()["documents"])
        for directory in (self.documents_dir, self.catalogs_dir):
            shutil.rmtree(directory, ignore_errors=True)
        self._ensure_layout()
        self._write_index(self._empty_index())
        return count

    def _ensure_layout(self) -> None:
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.documents_dir.mkdir(exist_ok=True)
        self.catalogs_dir.mkdir(exist_ok=True)
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
        temporary_path = destination.with_suffix(f"{destination.suffix}.tmp")
        try:
            with temporary_path.open("w", encoding="utf-8") as output:
                json.dump(data, output, ensure_ascii=False, indent=2)
            os.replace(temporary_path, destination)
        except OSError as error:
            temporary_path.unlink(missing_ok=True)
            raise CurriculumStoreError("INTERNAL_ERROR", "培养方案数据写入失败") from error


def _document_id(major: str, cohort: str, version: str, digest: str) -> str:
    return "-".join(("curriculum", _slug(major), _slug(cohort), _slug(version), digest[:12]))


def _slug(value: str) -> str:
    normalized = re.sub(r"[^\w]+", "-", value.strip(), flags=re.UNICODE).strip("-_").lower()
    return normalized or "unspecified"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
