"""Stdio MCP server exposing deterministic course-path planning."""

from __future__ import annotations

import logging
import os
import re
import sys
import time
from hashlib import sha256
from pathlib import Path
from typing import Any
from uuid import uuid4

from mcp.server.fastmcp import FastMCP

from schemas.common import error_response, success_response
from schemas.course_path_plan import CoursePathInput, CoursePathRuleError
from schemas.curriculum_extract import CurriculumExtractError, CurriculumExtractInput
from schemas.catalog_review import CatalogReviewError, CatalogReviewInput
from schemas.attachment_extract import AttachmentExtractError, AttachmentExtractInput
from schemas.curriculum_search import CurriculumIndexInput, CurriculumSearchInput, CurriculumSearchInputError
from tools.course_path_rules import build_course_path_data, build_curriculum_graph_data, load_course_catalog
from tools.catalog_validate import validate_catalog
from tools.curriculum_extract import ProgramPlanParseError, extract_catalog_draft, parse_program_plan_pages, validate_recommended_sequences
from tools.catalog_review import review_catalog
from tools.attachment_validation import inspect_attachment
from tools.attachment_extract import (
    extract_catalog_from_attachment,
    extract_catalog_from_stored_attachment,
    extract_document_sources,
    native_page_text_for_probe,
    native_pdf_pages_for_plan,
    rendered_plan_flow_page,
    source_previews,
)
from tools.curriculum_store import AnonymousProgressStore, CurriculumKnowledgeStore, CurriculumStoreError
from tools.dashscope_client import DashScopeClient, DashScopeConfig, DashScopeError
from tools.curriculum_search import (
    CurriculumSearchError,
    CurriculumSearchIndex,
    configured_embedding_model,
    configured_semantic_fallback,
    rank_lexical_sources,
)


PROJECT_ROOT = Path(__file__).resolve().parent
CATALOG_PATH = PROJECT_ROOT / "data" / "course_catalog.json"
LOCAL_EVIDENCE_MODEL = "local-lexical-v1"


def configured_directory(environment_name: str, default: Path) -> Path:
    """Resolve an optional local storage directory without exposing its value."""
    configured_value = os.getenv(environment_name, "").strip()
    if not configured_value:
        return default
    candidate = Path(configured_value).expanduser()
    if not candidate.is_absolute():
        candidate = PROJECT_ROOT / candidate
    return candidate.resolve()


CURRICULUM_KNOWLEDGE_BASE_PATH = configured_directory(
    "CURRICULUM_KNOWLEDGE_BASE_DIR",
    PROJECT_ROOT / "curriculum_knowledge_base",
)

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger("course_path_server")

mcp = FastMCP("course-path-server")
curriculum_store = CurriculumKnowledgeStore(CURRICULUM_KNOWLEDGE_BASE_PATH)
progress_store = AnonymousProgressStore(
    configured_directory("COURSE_PATH_PROGRESS_DIR", PROJECT_ROOT / "student_progress")
)


def handle_parse_program_plan(
    file_path: str, file_name: str | None = None, *, include_flow: bool = False
) -> dict[str, Any]:
    """Return the front-end v2 JSON directly; never publish a planning catalog."""
    _ = file_name  # The actual file content, not a caller-supplied name, determines the result.
    try:
        if not isinstance(file_path, str) or not file_path.strip() or not Path(file_path).is_absolute():
            raise ProgramPlanParseError("PARSE_FAILED", "请选择本机培养方案文件")
        source = Path(file_path).resolve(strict=True)
        if not source.is_file():
            raise ProgramPlanParseError("FILE_CORRUPTED", "文件损坏或无法读取，请重新上传")
        if source.suffix.lower() != ".pdf":
            raise ProgramPlanParseError("UNSUPPORTED_FORMAT", "当前仅支持可复制文字的 PDF 培养方案")
        if source.stat().st_size > 20 * 1024 * 1024:
            raise ProgramPlanParseError("PARSE_FAILED", "文件超过 20 MB，请提供较小的培养方案")
        digest = sha256(source.read_bytes()).hexdigest()
        matched = [
            record for record in curriculum_store.list_documents()
            if record.get("sha256") == digest
        ]
        cohorts = {
            record.get("cohort")
            for record in matched
            if re.fullmatch(r"20\d{2}", str(record.get("cohort") or ""))
        }
        versions = {
            record.get("version")
            for record in matched
            if record.get("version") and record.get("version") != "auto"
        }
        filename_year = re.search(r"(?:^|\D)(20\d{2})(?:\D|$)", source.stem)
        grade = next(iter(cohorts)) if len(cohorts) == 1 else filename_year.group(1) if filename_year else ""
        version = next(iter(versions)) if len(versions) == 1 else None
        pages = native_pdf_pages_for_plan(source)
        result = parse_program_plan_pages(pages, grade=grade, version=version)
        if not grade:
            result["warnings"].append("原文和文件名未明确标注适用年级，已标记为未注明，请在确认页核对。")
        if include_flow:
            result["recommendedSequences"] = []
            flow_page = next(
                (number for number, text in enumerate(pages, start=1) if "课程体系配置流程图" in text),
                None,
            )
            if flow_page is None:
                result["warnings"].append("未找到课程体系配置流程图；未添加推荐顺序连线。")
            else:
                try:
                    config = DashScopeConfig.from_file(PROJECT_ROOT / "data" / "model_config.json")
                    with rendered_plan_flow_page(source, flow_page) as image:
                        candidates = DashScopeClient(config).extract_recommended_sequences(image, result["courses"])
                    edges, rejected = validate_recommended_sequences(
                        candidates, result["courses"], page=flow_page
                    )
                    result["recommendedSequences"] = edges
                    if rejected:
                        result["warnings"].append(f"{rejected} 条流程图候选连线因端点不明或与课程表冲突而被舍弃。")
                    if edges:
                        result["warnings"].append(
                            "虚线仅表示模型从课程体系流程图识别的推荐顺序，未经官方先修规则核实，不用于选课资格判断。"
                        )
                    else:
                        result["warnings"].append("未识别到可靠的逐门推荐顺序连线。")
                except (DashScopeError, AttachmentExtractError, OSError, ValueError):
                    result["warnings"].append("流程图识别暂不可用；课程节点仍可预览，未添加推荐顺序连线。")
        if len(cohorts) == 1:
            result["warnings"].append("适用年级取自此前入库登记，请核对原文件适用年级。")
        elif filename_year:
            result["warnings"].append("适用年级取自文件名，请核对原文件适用年级。")
        if version is not None:
            result["warnings"].append("版本号取自此前入库登记，请核对原文件版本。")
        return result
    except ProgramPlanParseError as error:
        return {"success": False, "errorCode": error.code, "errorMessage": error.message}
    except AttachmentExtractError as error:
        return {"success": False, "errorCode": error.code, "errorMessage": error.message}
    except (OSError, ValueError, CurriculumStoreError):
        return {"success": False, "errorCode": "FILE_CORRUPTED", "errorMessage": "文件损坏或无法读取，请重新上传"}


def curriculum_search_index(base_dir: Path | None = None) -> CurriculumSearchIndex:
    """Create a curriculum-only vector index lazily for safe stdio startup."""
    score_threshold = curriculum_score_threshold()
    return CurriculumSearchIndex(
        (base_dir or CURRICULUM_KNOWLEDGE_BASE_PATH) / "vector_index",
        score_threshold=score_threshold,
    )


def curriculum_score_threshold() -> float:
    """Read and validate the shared lexical/semantic score threshold."""
    try:
        score_threshold = float(os.getenv("CURRICULUM_SCORE_THRESHOLD", "0.3"))
    except ValueError as error:
        raise CurriculumSearchError(
            "INTERNAL_ERROR",
            "培养方案检索配置无效",
            {"reason": "score_threshold_invalid"},
        ) from error
    if not 0 <= score_threshold <= 1:
        raise CurriculumSearchError(
            "INTERNAL_ERROR",
            "培养方案检索配置无效",
            {"reason": "score_threshold_out_of_range"},
        )
    return score_threshold


def handle_course_path_plan(payload: dict[str, Any]) -> dict[str, Any]:
    """Evaluate one request and always return the shared response envelope."""
    started_at = time.perf_counter()
    request_id = uuid4().hex
    meta = {"tool": "course_path_plan", "request_id": request_id}

    try:
        input_data = CoursePathInput.from_payload(payload)
        if input_data.document_id:
            document, catalog = _verified_curriculum_catalog(input_data.document_id)
            if input_data.grade != catalog.get("cohort"):
                raise CoursePathRuleError(
                    code="INVALID_ARGUMENT",
                    message="年级与培养方案不一致",
                    details={"reason": "cohort_mismatch"},
                )
        else:
            document = None
            catalog = load_course_catalog(CATALOG_PATH)
        result = build_course_path_data(input_data, catalog)
        if document is not None:
            result["document_id"] = document["document_id"]
        attachment = inspect_attachment(input_data.attachment_path)
        if attachment is not None:
            result["attachment"] = attachment
            if attachment["status"] != "VALID":
                result["warnings"].append(attachment["reason"])
        sources = result.pop("sources", [])
        warnings = result.pop("warnings", [])
        if result.get("data_status") == "auto_verified" and document is not None:
            warnings.append("COURSE_CATALOG_AUTO_VERIFIED")
        elif result.get("data_status") not in {"verified", "official"}:
            warnings.append("COURSE_CATALOG_NOT_VERIFIED")
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return success_response(result, sources=sources, warnings=warnings, meta=meta)
    except (CoursePathRuleError, CurriculumStoreError) as error:
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
        warnings = _extraction_warnings(result, persisted=False)
        return success_response(
            result,
            sources=source_previews(result.get("sources", [])),
            warnings=warnings,
            meta=meta,
        )
    except AttachmentExtractError as error:
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response(error.code, error.message, details=error.details, meta=meta)
    except Exception:
        logger.exception("curriculum_extract_from_attachment failed")
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response("INTERNAL_ERROR", "内部错误", meta=meta)


def handle_curriculum_ingest_from_attachment(payload: dict[str, Any]) -> dict[str, Any]:
    """Persist one shared curriculum document without starting remote work."""
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
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return success_response(
            {
                "document": document,
                "created": created,
                "rag_index": _rag_state(document),
                "extraction": {"status": document["extraction_status"]},
                "catalog_published": False,
                "next_actions": _document_next_actions(document),
            },
            warnings=["CURRICULUM_DOCUMENT_STORED", "PROCESSING_NOT_STARTED"],
            meta=meta,
        )
    except (AttachmentExtractError, CurriculumStoreError) as error:
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response(error.code, error.message, details=error.details, meta=meta)
    except Exception:
        logger.exception("curriculum_ingest_from_attachment failed")
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response("INTERNAL_ERROR", "内部错误", meta=meta)


def handle_curriculum_index_document(payload: dict[str, Any]) -> dict[str, Any]:
    """Build or reuse the RAG index for one already stored curriculum."""
    started_at = time.perf_counter()
    meta = {"tool": "curriculum_index_document", "request_id": uuid4().hex}
    try:
        input_data = CurriculumIndexInput.from_payload(payload)
        document, source, _inspection = curriculum_store.load_source_for_retry(input_data.document_id)
        document, rag_index, warnings = _index_curriculum_document(
            document,
            source=source,
            force=input_data.force,
        )
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        if not rag_index["indexed"]:
            error = rag_index["error"]
            return error_response(error["code"], error["message"], details=error["details"], meta=meta)
        return success_response(
            {
                "document": document,
                "rag_index": rag_index,
                "next_actions": _document_next_actions(document),
            },
            warnings=warnings,
            meta=meta,
        )
    except (CurriculumSearchInputError, CurriculumSearchError, CurriculumStoreError) as error:
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response(error.code, error.message, details=error.details, meta=meta)
    except Exception:
        logger.exception("curriculum_index_document failed")
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response("INTERNAL_ERROR", "内部错误", meta=meta)


def handle_retry_curriculum_extraction(document_id: str) -> dict[str, Any]:
    """Retry extraction from a hash-checked curriculum source already in storage."""
    started_at = time.perf_counter()
    meta = {"tool": "retry_curriculum_extraction", "request_id": uuid4().hex}
    try:
        if not isinstance(document_id, str) or not document_id.strip():
            raise AttachmentExtractError("INVALID_ARGUMENT", "重试参数错误", {"reason": "document_id_required"})
        document, source, inspection = curriculum_store.load_source_for_retry(document_id.strip())
        input_data = AttachmentExtractInput(
            attachment_path=str(source),
            major=document["major"],
            cohort=document["cohort"],
            version=document["version"],
        )
        try:
            extraction = extract_catalog_from_stored_attachment(input_data, source, inspection)
        except AttachmentExtractError as error:
            extraction_error = _safe_extraction_error(error)
            error_stage = extraction_error["details"].get("stage")
            document = curriculum_store.record_extraction_failure(
                document["document_id"],
                error.code,
                error_stage=error_stage if isinstance(error_stage, str) else None,
                error_reason=extraction_error["details"].get("reason"),
            )
            meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
            return success_response(
                {
                    "document": document,
                    "extraction": {"ok": False, "error": extraction_error},
                    "rag_index": _rag_state(document),
                    "catalog_published": False,
                    "next_actions": _document_next_actions(document),
                },
                warnings=["CURRICULUM_EXTRACTION_FAILED", error.code, "CATALOG_NOT_PUBLISHED"],
                meta=meta,
            )

        document = curriculum_store.save_extraction_result(document["document_id"], extraction)
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        warnings = [*_extraction_warnings(extraction, persisted=True), "CURRICULUM_EXTRACTION_RETRIED"]
        next_actions = _document_next_actions(document)
        summary = extraction.get("extraction_summary")
        if isinstance(summary, dict) and any(
            isinstance(failure, dict)
            and failure.get("code") == "MODEL_REQUEST_FAILED"
            and isinstance(failure.get("reason"), str)
            for failure in summary.get("pages_failed", [])
        ):
            next_actions.insert(0, {"action": "CHECK_MODEL_CONNECTION", "tool": "curriculum_model_check"})
        return success_response(
            {
                "document": document,
                "rag_index": _rag_state(document),
                "extraction": {
                    "summary": extraction.get("extraction_summary"),
                    "catalog": extraction.get("catalog"),
                    "validation": extraction["validation"],
                    "review": extraction["review"],
                    "course_line_candidates": extraction.get("course_line_candidates", []),
                },
                "catalog_published": False,
                "next_actions": next_actions,
            },
            sources=source_previews(extraction.get("sources", [])),
            warnings=list(dict.fromkeys(warnings)),
            meta=meta,
        )
    except (AttachmentExtractError, CurriculumStoreError) as error:
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response(error.code, error.message, details=error.details, meta=meta)
    except Exception:
        logger.exception("retry_curriculum_extraction failed")
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response("INTERNAL_ERROR", "内部错误", meta=meta)


def handle_curriculum_model_check() -> dict[str, Any]:
    """Check extraction-model connectivity without uploading or reading a file."""
    started_at = time.perf_counter()
    meta = {"tool": "curriculum_model_check", "request_id": uuid4().hex}
    try:
        config = DashScopeConfig.from_file(PROJECT_ROOT / "data" / "model_config.json")
        DashScopeClient(config).check_connection()
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return success_response({"reachable": True, "model": config.ocr_model}, meta=meta)
    except DashScopeError as error:
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response(error.code, error.message, details=error.details, meta=meta)


def handle_curriculum_extraction_probe(document_id: str, page: int) -> dict[str, Any]:
    """Compare two bounded transport modes for one stored PDF page only."""
    started_at = time.perf_counter()
    meta = {"tool": "curriculum_extraction_probe", "request_id": uuid4().hex}
    try:
        if not isinstance(document_id, str) or not document_id.strip():
            raise AttachmentExtractError("INVALID_ARGUMENT", "诊断参数错误", {"reason": "document_id_required"})
        if isinstance(page, bool) or not isinstance(page, int) or not 1 <= page <= 1000:
            raise AttachmentExtractError("INVALID_ARGUMENT", "诊断参数错误", {"reason": "page_out_of_range"})
        document, source, _inspection = curriculum_store.load_source_for_retry(document_id.strip())
        page_text = native_page_text_for_probe(source, page)
        config = DashScopeConfig.from_file(PROJECT_ROOT / "data" / "model_config.json")
        modes: dict[str, dict[str, Any]] = {}
        for mode, stream in (("non_stream", False), ("stream", True)):
            mode_started = time.perf_counter()
            try:
                DashScopeClient(config).probe_extraction_transport(page_text, stream=stream)
                modes[mode] = {"reachable": True, "error_code": None, "reason": None}
            except DashScopeError as error:
                reason = error.details.get("reason")
                modes[mode] = {
                    "reachable": False,
                    "error_code": error.code,
                    "reason": reason if isinstance(reason, str) else None,
                }
            modes[mode]["elapsed_ms"] = round((time.perf_counter() - mode_started) * 1000)
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return success_response(
            {
                "document_id": document["document_id"],
                "page": page,
                "model": config.ocr_model,
                "input_characters": len(page_text),
                "modes": modes,
            },
            meta=meta,
        )
    except (AttachmentExtractError, CurriculumStoreError, DashScopeError) as error:
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response(error.code, error.message, details=error.details, meta=meta)


def _safe_extraction_error(error: AttachmentExtractError) -> dict[str, Any]:
    """Return diagnostic fields that cannot contain attachment or model content."""
    details: dict[str, Any] = {}
    raw_reason = error.details.get("reason")
    if isinstance(raw_reason, str) and re.fullmatch(r"[a-z0-9_]{1,80}", raw_reason):
        details["reason"] = raw_reason

    raw_stage = error.details.get("stage")
    if raw_stage in {"ocr", "review"}:
        details["stage"] = raw_stage

    raw_row = error.details.get("row")
    if isinstance(raw_row, int) and raw_row > 0:
        details["row"] = raw_row

    raw_page = error.details.get("page")
    if isinstance(raw_page, int) and raw_page > 0:
        details["page"] = raw_page

    raw_columns = error.details.get("columns")
    if isinstance(raw_columns, list):
        allowed_columns = {
            "course_code",
            "course_name",
            "credits",
            "semester",
            "category",
            "prerequisites",
            "page",
            "section",
        }
        columns = [column for column in raw_columns if isinstance(column, str) and column in allowed_columns]
        if columns:
            details["columns"] = columns

    raw_status = error.details.get("status")
    if isinstance(raw_status, int) and 100 <= raw_status <= 599:
        details["status"] = raw_status

    raw_attempts = error.details.get("attempts")
    if isinstance(raw_attempts, int) and 1 <= raw_attempts <= 10:
        details["attempts"] = raw_attempts

    raw_format = error.details.get("format")
    if raw_format in {"json", "html_table", "markdown_table", "tsv", "plain_text"}:
        details["format"] = raw_format

    return {
        "code": error.code,
        "message": error.message,
        "details": details,
    }


def _extraction_warnings(result: dict[str, Any], *, persisted: bool) -> list[str]:
    """Collect bounded interpretation warnings for one MCP response."""
    warnings: list[str] = []
    validation = result.get("validation")
    if isinstance(validation, dict):
        warnings.extend(item for item in validation.get("warnings", []) if isinstance(item, str))
    review = result.get("review")
    if isinstance(review, dict):
        warnings.extend(item for item in review.get("warnings", []) if isinstance(item, str))
    catalog = result.get("catalog")
    if isinstance(catalog, dict):
        warnings.extend(item for item in catalog.get("extraction_warnings", []) if isinstance(item, str))
    summary = result.get("extraction_summary")
    if isinstance(summary, dict):
        if summary.get("status") == "EXTRACTION_PARTIAL":
            warnings.append("CURRICULUM_EXTRACTION_PARTIAL")
        elif summary.get("status") == "EXTRACTION_FAILED":
            warnings.append("CURRICULUM_EXTRACTION_FAILED")
    warnings.append("CATALOG_NOT_PUBLISHED" if persisted else "CATALOG_NOT_PERSISTED")
    return list(dict.fromkeys(warnings))


def _index_curriculum_document(
    document: dict[str, Any],
    *,
    source: Path | None = None,
    force: bool = False,
) -> tuple[dict[str, Any], dict[str, Any], list[str]]:
    """Index all native document text while keeping ingestion recoverable."""
    embedding_model = configured_embedding_model()
    sources = curriculum_store.load_evidence(document["document_id"])
    if sources is None:
        if source is None:
            _entry, source, _inspection = curriculum_store.load_source_for_retry(document["document_id"])
        sources = extract_document_sources(source, document["original_filename"])
        document = curriculum_store.save_evidence(document["document_id"], sources)
    if not sources:
        error = CurriculumSearchError(
            "NO_EVIDENCE",
            "培养方案中没有可索引文本",
            {"reason": "document_text_empty"},
        )
        updated = curriculum_store.record_rag_failure(document["document_id"], error.code, reason="document_text_empty")
        return (
            updated,
            {
                "indexed": False,
                "chunk_count": 0,
                "error": {"code": error.code, "message": error.message, "details": error.details},
            },
            ["CURRICULUM_EVIDENCE_INDEX_FAILED", error.code],
        )

    if not configured_semantic_fallback():
        if document.get("rag_status") == "INDEXED":
            updated = document
            skipped = True
        else:
            updated = curriculum_store.record_rag_index(
                document["document_id"],
                len(sources),
                LOCAL_EVIDENCE_MODEL,
            )
            skipped = False
        return (
            updated,
            {
                "indexed": True,
                "index_mode": "lexical",
                "chunk_count": len(sources),
                "skipped": skipped,
                "semantic_indexed": updated.get("rag_embedding_model") != LOCAL_EVIDENCE_MODEL,
            },
            ["CURRICULUM_LOCAL_EVIDENCE_READY"],
        )
    if (
        not force
        and document.get("rag_status") == "INDEXED"
        and document.get("rag_embedding_model") == embedding_model
    ):
        chunk_count = int(document.get("rag_chunk_count") or 0)
        return (
            document,
            {
                "indexed": True,
                "chunk_count": chunk_count,
                "skipped": True,
                "reason": "DOCUMENT_ALREADY_INDEXED",
            },
            ["CURRICULUM_RAG_ALREADY_INDEXED"],
        )
    try:
        chunk_count = curriculum_search_index(curriculum_store.base_dir).index_sources(document, sources)
        updated = curriculum_store.record_rag_index(document["document_id"], chunk_count, embedding_model)
        return (
            updated,
            {"indexed": True, "chunk_count": chunk_count, "skipped": False},
            ["CURRICULUM_RAG_INDEXED"],
        )
    except CurriculumSearchError as error:
        reason = error.details.get("reason")
        safe_reason = reason if isinstance(reason, str) and re.fullmatch(r"[a-z0-9_]{1,80}", reason) else None
        updated = curriculum_store.record_rag_failure(document["document_id"], error.code, reason=safe_reason)
        return (
            updated,
            {
                "indexed": False,
                "chunk_count": 0,
                "error": {"code": error.code, "message": error.message, "details": error.details},
            },
            ["CURRICULUM_RAG_INDEX_FAILED", error.code],
        )


def _rag_state(document: dict[str, Any]) -> dict[str, Any]:
    """Return the current non-secret RAG state without starting work."""
    return {
        "indexed": document.get("rag_status") == "INDEXED",
        "status": document.get("rag_status", "NOT_INDEXED"),
        "chunk_count": int(document.get("rag_chunk_count") or 0),
        "embedding_model": document.get("rag_embedding_model"),
    }


def _document_next_actions(document: dict[str, Any]) -> list[dict[str, str]]:
    """Describe explicit follow-up tools without invoking them implicitly."""
    actions: list[dict[str, str]] = []
    if document.get("rag_status") != "INDEXED":
        actions.append(
            {
                "action": "INDEX_CURRICULUM_DOCUMENT",
                "tool": "curriculum_index_document",
            }
        )
    if document.get("extraction_status") != "AUTO_VERIFIED":
        actions.append(
            {
                "action": "EXTRACT_COURSE_CATALOG",
                "tool": "retry_curriculum_extraction",
            }
        )
    return actions


def handle_curriculum_search(payload: dict[str, Any]) -> dict[str, Any]:
    """Search only curriculum evidence and return the shared response envelope."""
    started_at = time.perf_counter()
    meta = {"tool": "curriculum_search", "request_id": uuid4().hex}
    try:
        input_data = CurriculumSearchInput.from_payload(payload)
        result = _search_portable_curriculum_evidence(input_data)
        if not result["sources"] and configured_semantic_fallback():
            result = curriculum_search_index(curriculum_store.base_dir).search(input_data)
        sources = result.pop("sources")
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        if not sources:
            details = {"filters": result["filters"]}
            if result.get("top_score") is not None:
                details["top_score"] = result["top_score"]
            return error_response("NO_EVIDENCE", "培养方案知识库中未找到可靠依据", details=details, meta=meta)
        return success_response(result, sources=sources, meta=meta)
    except (CurriculumSearchInputError, CurriculumSearchError, CurriculumStoreError) as error:
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response(error.code, error.message, details=error.details, meta=meta)


def _search_portable_curriculum_evidence(input_data: CurriculumSearchInput) -> dict[str, Any]:
    """Search JSON page chunks without opening Chroma in the stdio process."""
    filters = {
        key: value
        for key, value in {
            "major": input_data.major,
            "cohort": input_data.cohort,
            "version": input_data.version,
            "document_id": input_data.document_id,
        }.items()
        if value is not None
    }
    if input_data.document_id is not None:
        document, _extraction = curriculum_store.load_extraction_result(input_data.document_id)
        documents = [document] if _document_matches_filters(document, filters) else []
    else:
        documents = curriculum_store.list_documents(
            major=input_data.major,
            cohort=input_data.cohort,
            version=input_data.version,
        )

    sources: list[dict[str, Any]] = []
    unindexed_document_ids: list[str] = []
    for document in documents:
        document_sources = curriculum_store.load_evidence(document["document_id"])
        if document_sources is None:
            unindexed_document_ids.append(document["document_id"])
            continue
        sources.extend(document_sources)
    if not sources and unindexed_document_ids:
        raise CurriculumSearchError(
            "EVIDENCE_NOT_INDEXED",
            "培养方案尚未建立本地证据索引",
            {
                "document_ids": unindexed_document_ids,
                "next_tool": "curriculum_index_document",
            },
        )
    ranked = rank_lexical_sources(
        input_data.query,
        sources,
        top_k=input_data.top_k,
        score_threshold=curriculum_score_threshold(),
    )
    return {
        "query": input_data.query,
        "filters": filters,
        "search_mode": "lexical",
        "match_count": len(ranked["sources"]),
        "top_score": ranked["top_score"],
        "sources": ranked["sources"],
    }


def _document_matches_filters(document: dict[str, Any], filters: dict[str, str]) -> bool:
    """Apply request metadata filters before loading local evidence."""
    return all(document.get(key) == value for key, value in filters.items())


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


def handle_get_curriculum_document(document_id: str) -> dict[str, Any]:
    """Return one stored curriculum interpretation with bounded source previews."""
    started_at = time.perf_counter()
    meta = {"tool": "get_curriculum_document", "request_id": uuid4().hex}
    try:
        if not isinstance(document_id, str) or not document_id.strip():
            raise AttachmentExtractError("INVALID_ARGUMENT", "查询参数错误", {"reason": "document_id_required"})
        document, extraction = curriculum_store.load_extraction_result(document_id.strip())
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        if extraction is None:
            return success_response(
                {"document": document, "extraction": None},
                warnings=["CURRICULUM_EXTRACTION_NOT_AVAILABLE"],
                meta=meta,
            )
        sources = extraction.get("sources", [])
        return success_response(
            {
                "document": document,
                "extraction": {
                    "summary": extraction.get("extraction_summary"),
                    "catalog": extraction.get("catalog"),
                    "validation": extraction.get("validation"),
                    "review": extraction.get("review"),
                    "course_line_candidates": extraction.get("course_line_candidates", []),
                },
            },
            sources=source_previews(sources if isinstance(sources, list) else []),
            warnings=_extraction_warnings(extraction, persisted=True),
            meta=meta,
        )
    except (AttachmentExtractError, CurriculumStoreError) as error:
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response(error.code, error.message, details=error.details, meta=meta)


def _verified_curriculum_catalog(document_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """Use exactly the same release gate for graph reads and progress writes."""
    document, extraction = curriculum_store.load_extraction_result(document_id)
    catalog = extraction.get("catalog") if isinstance(extraction, dict) else None
    summary = extraction.get("extraction_summary") if isinstance(extraction, dict) else None
    review = extraction.get("review") if isinstance(extraction, dict) else None
    ready = (
        isinstance(catalog, dict)
        and isinstance(summary, dict)
        and summary.get("status") == "EXTRACTION_COMPLETE"
        and isinstance(review, dict)
        and review.get("auto_verified") is True
        and document.get("auto_verified") is True
    )
    validation = validate_catalog(catalog) if isinstance(catalog, dict) else {"valid": False}
    if not ready or not validation["valid"] or not catalog.get("courses"):
        details: dict[str, Any] = {
            "document_id": document["document_id"],
            "processing_status": document["processing_status"],
        }
        failures = summary.get("pages_failed", []) if isinstance(summary, dict) else []
        if isinstance(failures, list):
            first = next(
                (item for item in failures if isinstance(item, dict) and item.get("circuit_open") is not True),
                None,
            )
            if first is not None:
                page = first.get("page")
                if isinstance(page, int) and not isinstance(page, bool) and page > 0:
                    details["failed_page"] = page
                for source_key, target_key, pattern in (
                    ("code", "failure_code", r"[A-Z0-9_]{1,80}"),
                    ("stage", "failure_stage", r"[a-z0-9_]{1,80}"),
                    ("reason", "failure_reason", r"[a-z0-9_]{1,80}"),
                ):
                    value = first.get(source_key)
                    if isinstance(value, str) and re.fullmatch(pattern, value):
                        details[target_key] = value
        raise CurriculumStoreError(
            "CATALOG_NOT_READY",
            "尚无可生成课程图的完整培养方案目录",
            details,
        )
    return document, catalog


def handle_curriculum_graph(document_id: str) -> dict[str, Any]:
    """Return graph data only when a complete catalog passed validation and review."""
    started_at = time.perf_counter()
    meta = {"tool": "curriculum_graph", "request_id": uuid4().hex}
    try:
        if not isinstance(document_id, str) or not document_id.strip():
            raise AttachmentExtractError("INVALID_ARGUMENT", "图数据参数错误", {"reason": "document_id_required"})
        document, catalog = _verified_curriculum_catalog(document_id.strip())
        data = build_curriculum_graph_data(document["document_id"], catalog)
        warnings = ["GRADUATION_CREDITS_NOT_STRUCTURED"] if data["total_credits"] is None else []
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return success_response(data, warnings=warnings, meta=meta)
    except (AttachmentExtractError, CurriculumStoreError) as error:
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response(error.code, error.message, details=error.details, meta=meta)


def _progress_known_course_codes(document_id: str) -> set[str]:
    """Authorize private progress against verified rules or a hash-checked PDF preview."""
    try:
        _document, catalog = _verified_curriculum_catalog(document_id)
        return {course["course_code"] for course in catalog["courses"]}
    except CurriculumStoreError as error:
        if error.code != "CATALOG_NOT_READY":
            raise

    document, source, _attachment = curriculum_store.load_source_for_retry(document_id)
    try:
        preview = parse_program_plan_pages(
            native_pdf_pages_for_plan(source),
            grade=str(document.get("cohort") or ""),
            version=document.get("version") if isinstance(document.get("version"), str) else None,
        )
    except (ProgramPlanParseError, AttachmentExtractError, OSError, ValueError) as error:
        raise CurriculumStoreError(
            "PREVIEW_NOT_READY", "培养方案课程预览不可用于保存修读状态"
        ) from error
    return {course["id"] for course in preview["courses"]}


def handle_save_course_progress(profile_id: str, document_id: str, course_statuses: dict[str, str]) -> dict[str, Any]:
    """Save only anonymous status codes, never into the shared curriculum partition."""
    started_at = time.perf_counter()
    meta = {"tool": "save_course_progress", "request_id": uuid4().hex}
    try:
        known_codes = _progress_known_course_codes(document_id)
        progress = progress_store.save(profile_id, document_id, course_statuses, known_codes)
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return success_response(progress, meta=meta)
    except CurriculumStoreError as error:
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response(error.code, error.message, details=error.details, meta=meta)


def handle_load_course_progress(profile_id: str, document_id: str) -> dict[str, Any]:
    """Load one anonymous profile for a stored curriculum document."""
    started_at = time.perf_counter()
    meta = {"tool": "load_course_progress", "request_id": uuid4().hex}
    try:
        _progress_known_course_codes(document_id)
        progress = progress_store.load(profile_id, document_id)
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return success_response(progress, meta=meta)
    except CurriculumStoreError as error:
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response(error.code, error.message, details=error.details, meta=meta)


def handle_clear_course_progress(profile_id: str, document_id: str, confirm: bool) -> dict[str, Any]:
    """Clear one profile/plan record only after explicit confirmation."""
    started_at = time.perf_counter()
    meta = {"tool": "clear_course_progress", "request_id": uuid4().hex}
    try:
        if confirm is not True:
            raise CurriculumStoreError("INVALID_ARGUMENT", "清除修读状态需要确认")
        removed = progress_store.clear(profile_id, document_id)
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return success_response({"removed": removed, "document_id": document_id}, meta=meta)
    except CurriculumStoreError as error:
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return error_response(error.code, error.message, details=error.details, meta=meta)


def handle_clear_curriculum_knowledge_base(payload: dict[str, Any]) -> dict[str, Any]:
    """Clear only the managed curriculum partition after explicit confirmation."""
    started_at = time.perf_counter()
    meta = {"tool": "clear_curriculum_knowledge_base", "request_id": uuid4().hex}
    try:
        if payload.get("confirm") is not True:
            raise CurriculumStoreError(
                "INVALID_ARGUMENT",
                "清空培养方案库需要确认",
                {"reason": "confirm_must_be_true"},
            )
        vector_index_path = curriculum_store.base_dir / "vector_index"
        vector_index_cleared = False
        if vector_index_path.exists():
            curriculum_search_index(curriculum_store.base_dir).clear()
            vector_index_cleared = True
        removed_documents = curriculum_store.clear(confirm=payload.get("confirm", False))
        meta["elapsed_ms"] = round((time.perf_counter() - started_at) * 1000)
        return success_response(
            {
                "knowledge_base": "curriculum",
                "removed_documents": removed_documents,
                "vector_index_cleared": vector_index_cleared,
                "course_catalog_modified": False,
            },
            warnings=["COURSE_CATALOG_MAY_BE_STALE"],
            meta=meta,
        )
    except (CurriculumStoreError, CurriculumSearchError) as error:
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
    document_id: str | None = None,
) -> dict[str, Any]:
    """Check prerequisites and missing courses for a target course.

    Pass document_id to use only that verified curriculum catalog. Without it,
    the tool retains the bundled demonstration catalog for legacy calls.
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
            "document_id": document_id,
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
async def parse_program_plan(filePath: str, fileName: str | None = None, includeFlow: bool = False) -> dict[str, Any]:
    """Return front-end v2 JSON for a text-layer curriculum PDF.

    Read only the given absolute path. The file must already carry a cohort in
    this server's document metadata or in its filename; do not guess one. This
    model-free preview does not verify prerequisites or publish a catalog.
    """
    return handle_parse_program_plan(filePath, fileName, include_flow=includeFlow)


@mcp.tool()
async def curriculum_ingest_from_attachment(
    attachment_path: str,
    major: str,
    cohort: str,
    version: str,
    catalog_id: str | None = None,
) -> dict[str, Any]:
    """Store a shared curriculum PDF/image in the curriculum knowledge base.

    Call this when the user uploads a curriculum plan and asks to import it,
    build a course catalog, or update a major's curriculum data. When the
    current conversation has an uploaded file, use its injected managed local
    path as attachment_path; never scan the user's folders to find a file.
    The user must provide major, cohort, and version; ask for missing values
    instead of guessing.

    Use only for common curriculum-plan documents, never student transcripts
    or personal records. The original attachment is copied but never modified.
    This call only validates and stores the source, so it returns quickly and
    never starts embedding, extraction, or review work. Use the returned
    document_id with the explicit follow-up tools. The public course catalog
    remains unchanged.
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
async def curriculum_index_document(document_id: str, force: bool = False) -> dict[str, Any]:
    """Build the curriculum-only evidence index for one stored document.

    This is a preparation/maintenance tool. Do not call it to answer a user's
    question about curriculum content; call curriculum_search for that.
    By default it extracts page chunks into a portable local JSON index and
    does not call an embedding model. When CURRICULUM_SEMANTIC_FALLBACK is
    enabled, it additionally builds the optional semantic index. This tool
    does not extract or publish a course catalog.
    """
    return handle_curriculum_index_document({"document_id": document_id, "force": force})


@mcp.tool()
async def retry_curriculum_extraction(document_id: str) -> dict[str, Any]:
    """Retry model extraction for a shared curriculum document already stored here.

    Use the document_id returned by list_curriculum_documents. This reads only
    the managed source copy and never requests an upload path or publishes the
    resulting catalog.
    """
    return handle_retry_curriculum_extraction(document_id)


@mcp.tool()
async def curriculum_model_check() -> dict[str, Any]:
    """Check the course-extraction model with one tiny request, without a file.

    Use this before retrying a document after a transport failure. It sends no
    curriculum or student content and never returns credentials or raw errors.
    """
    return handle_curriculum_model_check()


@mcp.tool()
async def curriculum_extraction_probe(document_id: str, page: int) -> dict[str, Any]:
    """Diagnose one stored PDF page in streaming/non-streaming mode.

    Sends the bounded native text of exactly one page to the configured model.
    This is an explicit diagnostic call, not a full extraction or catalog write.
    Only redacted transport outcomes are returned, never page text or secrets.
    """
    return handle_curriculum_extraction_probe(document_id, page)


@mcp.tool()
async def list_curriculum_documents(
    major: str | None = None,
    cohort: str | None = None,
    version: str | None = None,
) -> dict[str, Any]:
    """List documents stored in this server's shared curriculum partition."""
    return handle_list_curriculum_documents({"major": major, "cohort": cohort, "version": version})


@mcp.tool()
async def get_curriculum_document(document_id: str) -> dict[str, Any]:
    """Read one stored curriculum interpretation and its page-addressable evidence."""
    return handle_get_curriculum_document(document_id)


@mcp.tool()
async def curriculum_graph(document_id: str) -> dict[str, Any]:
    """Read validated graph nodes and edges from an auto-verified curriculum."""
    return handle_curriculum_graph(document_id)


@mcp.tool()
async def save_course_progress(
    profile_id: str,
    document_id: str,
    course_statuses: dict[str, str],
) -> dict[str, Any]:
    """Save anonymous local course status codes outside the public curriculum knowledge base."""
    return handle_save_course_progress(profile_id, document_id, course_statuses)


@mcp.tool()
async def load_course_progress(profile_id: str, document_id: str) -> dict[str, Any]:
    """Load one anonymous local course status profile for a reviewed curriculum."""
    return handle_load_course_progress(profile_id, document_id)


@mcp.tool()
async def clear_course_progress(profile_id: str, document_id: str, confirm: bool = False) -> dict[str, Any]:
    """Delete one anonymous status record only when confirm=true."""
    return handle_clear_course_progress(profile_id, document_id, confirm)


@mcp.tool()
async def curriculum_search(
    query: str,
    major: str | None = None,
    cohort: str | None = None,
    version: str | None = None,
    document_id: str | None = None,
    top_k: int = 5,
) -> dict[str, Any]:
    """Search the isolated curriculum knowledge base with page evidence.

    Call this tool, not curriculum_index_document, when the user asks a
    question about an already indexed curriculum document. It returns matched
    evidence with page and similarity score. It does not decide prerequisite
    eligibility and never searches policy documents or student progress.
    """
    return handle_curriculum_search(
        {
            "query": query,
            "major": major,
            "cohort": cohort,
            "version": version,
            "document_id": document_id,
            "top_k": top_k,
        }
    )


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
