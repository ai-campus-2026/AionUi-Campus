"""Stdio MCP server exposing deterministic course-path planning."""

from __future__ import annotations

import logging
import sys
import time
from pathlib import Path
from typing import Any
from uuid import uuid4

from mcp.server.fastmcp import FastMCP

from schemas.common import error_response, success_response
from schemas.course_path_plan import CoursePathInput, CoursePathRuleError
from schemas.curriculum_extract import CurriculumExtractError, CurriculumExtractInput
from schemas.catalog_review import CatalogReviewError, CatalogReviewInput
from schemas.attachment_extract import AttachmentExtractError, AttachmentExtractInput
from tools.course_path_rules import build_course_path_data, load_course_catalog
from tools.catalog_validate import validate_catalog
from tools.curriculum_extract import extract_catalog_draft
from tools.catalog_review import review_catalog
from tools.attachment_validation import inspect_attachment
from tools.attachment_extract import extract_catalog_from_attachment
from tools.curriculum_store import CurriculumKnowledgeStore, CurriculumStoreError


PROJECT_ROOT = Path(__file__).resolve().parent
CATALOG_PATH = PROJECT_ROOT / "data" / "course_catalog.json"
CURRICULUM_KNOWLEDGE_BASE_PATH = PROJECT_ROOT / "curriculum_knowledge_base"

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger("course_path_server")

mcp = FastMCP("course-path-server")
curriculum_store = CurriculumKnowledgeStore(CURRICULUM_KNOWLEDGE_BASE_PATH)


def handle_course_path_plan(payload: dict[str, Any]) -> dict[str, Any]:
    """Evaluate one request and always return the shared response envelope."""
    started_at = time.perf_counter()
    request_id = uuid4().hex
    meta = {"tool": "course_path_plan", "request_id": request_id}

    try:
        input_data = CoursePathInput.from_payload(payload)
        result = build_course_path_data(input_data, load_course_catalog(CATALOG_PATH))
        attachment = inspect_attachment(input_data.attachment_path)
        if attachment is not None:
            result["attachment"] = attachment
            if attachment["status"] != "VALID":
                result["warnings"].append(attachment["reason"])
        sources = result.pop("sources", [])
        warnings = result.pop("warnings", [])
        if result.get("data_status") not in {"verified", "official"}:
            warnings.append("COURSE_CATALOG_NOT_VERIFIED")
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return success_response(result, sources=sources, warnings=warnings, meta=meta)
    except CoursePathRuleError as error:
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response(
            error.code,
            error.message,
            details=error.details,
            meta=meta,
        )
    except Exception:
        logger.exception("course_path_plan failed")
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response("INTERNAL_ERROR", "内部错误", meta=meta)


def handle_catalog_validate(catalog: dict[str, Any]) -> dict[str, Any]:
    """Validate a catalog draft without writing, publishing, or overwriting data."""
    started_at = time.perf_counter()
    meta = {"tool": "catalog_validate", "request_id": uuid4().hex}
    result = validate_catalog(catalog)
    meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
    return success_response(result, warnings=result["warnings"], meta=meta)


def handle_curriculum_extract(payload: dict[str, Any]) -> dict[str, Any]:
    """Build a draft catalog from table text and return its validation result."""
    started_at = time.perf_counter()
    meta = {"tool": "curriculum_extract", "request_id": uuid4().hex}
    try:
        input_data = CurriculumExtractInput.from_payload(payload)
        catalog = extract_catalog_draft(input_data)
        validation = validate_catalog(catalog)
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return success_response(
            {"catalog": catalog, "validation": validation},
            sources=[
                {
                    "document": input_data.document,
                    "section": None,
                    "page": None,
                    "content": None,
                    "chunk_index": None,
                    "score": None,
                }
            ],
            warnings=validation["warnings"],
            meta=meta,
        )
    except CurriculumExtractError as error:
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response(error.code, error.message, details=error.details, meta=meta)
    except Exception:
        logger.exception("curriculum_extract failed")
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response("INTERNAL_ERROR", "内部错误", meta=meta)


def handle_catalog_review(payload: dict[str, Any]) -> dict[str, Any]:
    """Decide whether a model-reviewed catalog can be auto-verified."""
    started_at = time.perf_counter()
    meta = {"tool": "catalog_review", "request_id": uuid4().hex}
    try:
        result = review_catalog(CatalogReviewInput.from_payload(payload))
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return success_response(result, warnings=result["warnings"], meta=meta)
    except CatalogReviewError as error:
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response(error.code, error.message, details=error.details, meta=meta)
    except Exception:
        logger.exception("catalog_review failed")
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response("INTERNAL_ERROR", "内部错误", meta=meta)


def handle_curriculum_extract_from_attachment(payload: dict[str, Any]) -> dict[str, Any]:
    """Extract a transient curriculum catalog from a checked local attachment."""
    started_at = time.perf_counter()
    meta = {"tool": "curriculum_extract_from_attachment", "request_id": uuid4().hex}
    try:
        input_data = AttachmentExtractInput.from_payload(payload)
        result = extract_catalog_from_attachment(input_data)
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        warnings = [*result["validation"]["warnings"], *result["review"]["warnings"], "CATALOG_NOT_PERSISTED"]
        return success_response(result, warnings=list(dict.fromkeys(warnings)), meta=meta)
    except AttachmentExtractError as error:
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response(error.code, error.message, details=error.details, meta=meta)
    except Exception:
        logger.exception("curriculum_extract_from_attachment failed")
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response("INTERNAL_ERROR", "内部错误", meta=meta)


def handle_curriculum_ingest_from_attachment(payload: dict[str, Any]) -> dict[str, Any]:
    """Persist one shared curriculum document, then attempt extraction and review.

    A source document is retained even when model extraction is unavailable, so
    the caller can retry later.  No successful ingestion publishes or replaces
    the deterministic public course catalog.
    """
    started_at = time.perf_counter()
    meta = {"tool": "curriculum_ingest_from_attachment", "request_id": uuid4().hex}
    try:
        input_data = AttachmentExtractInput.from_payload(payload)
        attachment = inspect_attachment(input_data.attachment_path)
        if attachment is None or attachment["status"] != "VALID":
            reason = "ATTACHMENT_REQUIRED" if attachment is None else attachment["reason"]
            raise AttachmentExtractError("INVALID_ARGUMENT", "附件不可存入培养方案库", {"reason": reason})

        document, created = curriculum_store.store_source(
            attachment_path=input_data.attachment_path,
            attachment=attachment,
            major=input_data.major,
            cohort=input_data.cohort,
            version=input_data.version,
        )
        try:
            extraction = extract_catalog_from_attachment(input_data)
        except AttachmentExtractError as error:
            document = curriculum_store.record_extraction_failure(document["document_id"], error.code)
            meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
            return success_response(
                {
                    "document": document,
                    "created": created,
                    "extraction": None,
                    "catalog_published": False,
                },
                warnings=["CURRICULUM_DOCUMENT_STORED", "CURRICULUM_EXTRACTION_FAILED", error.code, "CATALOG_NOT_PUBLISHED"],
                meta=meta,
            )

        document = curriculum_store.save_extraction_result(document["document_id"], extraction)
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        warnings = [
            *extraction["validation"]["warnings"],
            *extraction["review"]["warnings"],
            "CURRICULUM_DOCUMENT_STORED",
            "CATALOG_NOT_PUBLISHED",
        ]
        return success_response(
            {
                "document": document,
                "created": created,
                "extraction": {
                    "validation": extraction["validation"],
                    "review": extraction["review"],
                },
                "catalog_published": False,
            },
            sources=[
                {
                    "document": document["original_filename"],
                    "section": None,
                    "page": None,
                    "content": None,
                    "chunk_index": None,
                    "score": None,
                }
            ],
            warnings=list(dict.fromkeys(warnings)),
            meta=meta,
        )
    except (AttachmentExtractError, CurriculumStoreError) as error:
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response(error.code, error.message, details=error.details, meta=meta)
    except Exception:
        logger.exception("curriculum_ingest_from_attachment failed")
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response("INTERNAL_ERROR", "内部错误", meta=meta)


def handle_list_curriculum_documents(payload: dict[str, Any]) -> dict[str, Any]:
    """List metadata from the curriculum partition without returning local paths."""
    started_at = time.perf_counter()
    meta = {"tool": "list_curriculum_documents", "request_id": uuid4().hex}
    try:
        filters = {field: _optional_filter(payload.get(field), field) for field in ("major", "cohort", "version")}
        documents = curriculum_store.list_documents(**filters)
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return success_response({"knowledge_base": "curriculum", "total": len(documents), "documents": documents}, meta=meta)
    except CurriculumStoreError as error:
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response(error.code, error.message, details=error.details, meta=meta)
    except AttachmentExtractError as error:
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response(error.code, error.message, details=error.details, meta=meta)


def handle_clear_curriculum_knowledge_base(payload: dict[str, Any]) -> dict[str, Any]:
    """Clear only the managed curriculum partition after explicit confirmation."""
    started_at = time.perf_counter()
    meta = {"tool": "clear_curriculum_knowledge_base", "request_id": uuid4().hex}
    try:
        removed_documents = curriculum_store.clear(confirm=payload.get("confirm", False))
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return success_response(
            {
                "knowledge_base": "curriculum",
                "removed_documents": removed_documents,
                "course_catalog_modified": False,
            },
            warnings=["COURSE_CATALOG_MAY_BE_STALE"],
            meta=meta,
        )
    except CurriculumStoreError as error:
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response(error.code, error.message, details=error.details, meta=meta)


def _optional_filter(value: Any, field: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise AttachmentExtractError("INVALID_ARGUMENT", "查询参数错误", {"reason": f"{field}_must_be_non_empty_string"})
    return value.strip()


@mcp.tool()
async def course_path_plan(
    major: str,
    grade: str,
    completed_courses: list[str],
    target_course: str | None = None,
    goal: str | None = None,
    planned_courses: list[str] | None = None,
    attachment_path: str | None = None,
) -> dict[str, Any]:
    """Check prerequisites and missing courses for a target course.

    The tool uses a versioned course catalog and deterministic rules. It does
    not infer missing curriculum data from an LLM or a knowledge base.
    """
    return handle_course_path_plan(
        {
            "major": major,
            "grade": grade,
            "completed_courses": completed_courses,
            "target_course": target_course,
            "goal": goal,
            "planned_courses": planned_courses,
            "attachment_path": attachment_path,
        }
    )


@mcp.tool()
async def catalog_validate(catalog: dict[str, Any]) -> dict[str, Any]:
    """Validate a course catalog draft without publishing it or modifying files."""
    return handle_catalog_validate(catalog)


@mcp.tool()
async def curriculum_extract(
    document: str,
    major: str,
    cohort: str,
    version: str,
    course_table_tsv: str,
    catalog_id: str | None = None,
) -> dict[str, Any]:
    """Convert extracted TSV curriculum-table text into a validated draft catalog.

    This tool does not parse PDF or image files directly. OCR or manual table
    extraction must provide the TSV text with the documented header columns.
    """
    return handle_curriculum_extract(
        {
            "document": document,
            "major": major,
            "cohort": cohort,
            "version": version,
            "course_table_tsv": course_table_tsv,
            "catalog_id": catalog_id,
        }
    )


@mcp.tool()
async def catalog_review(
    catalog: dict[str, Any],
    model_review: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Apply deterministic release rules to a structured model-review result.

    A provider adapter must supply model_review as JSON. This tool does not
    accept free-form model prose and never writes the reviewed catalog to disk.
    """
    return handle_catalog_review({"catalog": catalog, "model_review": model_review})


@mcp.tool()
async def curriculum_extract_from_attachment(
    attachment_path: str,
    major: str,
    cohort: str,
    version: str,
    catalog_id: str | None = None,
) -> dict[str, Any]:
    """Extract and review a transient catalog from a checked local PDF or image.

    It calls the configured local DashScope models and never writes the result
    into the public course catalog.
    """
    return handle_curriculum_extract_from_attachment(
        {
            "attachment_path": attachment_path,
            "major": major,
            "cohort": cohort,
            "version": version,
            "catalog_id": catalog_id,
        }
    )


@mcp.tool()
async def curriculum_ingest_from_attachment(
    attachment_path: str,
    major: str,
    cohort: str,
    version: str,
    catalog_id: str | None = None,
) -> dict[str, Any]:
    """Store a shared curriculum PDF/image in the curriculum knowledge base.

    Use only for common curriculum-plan documents, never student transcripts or
    personal records.  The original attachment is copied but never modified.
    Extraction and model review are attempted after storage; the public course
    catalog remains unchanged.
    """
    return handle_curriculum_ingest_from_attachment(
        {
            "attachment_path": attachment_path,
            "major": major,
            "cohort": cohort,
            "version": version,
            "catalog_id": catalog_id,
        }
    )


@mcp.tool()
async def list_curriculum_documents(
    major: str | None = None,
    cohort: str | None = None,
    version: str | None = None,
) -> dict[str, Any]:
    """List documents stored in this server's shared curriculum partition."""
    return handle_list_curriculum_documents({"major": major, "cohort": cohort, "version": version})


@mcp.tool()
async def clear_curriculum_knowledge_base(confirm: bool = False) -> dict[str, Any]:
    """Clear only the curriculum partition; pass confirm=true after user confirmation."""
    return handle_clear_curriculum_knowledge_base({"confirm": confirm})


def main() -> None:
    """Run the MCP server with the default stdio transport."""
    logger.info("course-path MCP server started with stdio transport")
    mcp.run()


if __name__ == "__main__":
    main()
