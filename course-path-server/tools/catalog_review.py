"""Safe automatic decision layer for structured curriculum-model reviews."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from schemas.catalog_review import CatalogReviewError, CatalogReviewInput
from tools.catalog_validate import validate_catalog


AUTO_VERIFY_CONFIDENCE = 0.90
BLOCKING_SEVERITIES = {"blocking", "high"}


def review_catalog(input_data: CatalogReviewInput) -> dict[str, Any]:
    """Combine deterministic validation with a structured model-review report.

    This function does not call a provider or write a file. It makes the final
    status decision deterministic after a provider adapter has returned JSON.
    """
    validation = validate_catalog(input_data.catalog)
    if input_data.model_review is None:
        return {
            "review_status": "MODEL_REVIEW_REQUIRED",
            "auto_verified": False,
            "catalog": deepcopy(input_data.catalog),
            "validation": validation,
            "review": None,
            "warnings": [*validation["warnings"], "MODEL_REVIEW_REQUIRED"],
        }

    review = _normalize_model_review(input_data.model_review)
    blocking_findings = [
        finding for finding in review["findings"] if finding["severity"] in BLOCKING_SEVERITIES
    ]
    confidence_is_sufficient = review["overall_confidence"] >= AUTO_VERIFY_CONFIDENCE
    auto_verified = validation["valid"] and confidence_is_sufficient and not blocking_findings

    reviewed_catalog = deepcopy(input_data.catalog)
    warnings = list(validation["warnings"])
    if auto_verified:
        reviewed_catalog["data_status"] = "auto_verified"
        review_status = "AUTO_VERIFIED"
        warnings.append("CATALOG_AUTO_VERIFIED_NOT_OFFICIAL")
    else:
        review_status = "REVIEW_FAILED"
        if not validation["valid"]:
            warnings.append("CATALOG_VALIDATION_FAILED")
        if not confidence_is_sufficient:
            warnings.append("MODEL_REVIEW_CONFIDENCE_LOW")
        if blocking_findings:
            warnings.append("MODEL_REVIEW_BLOCKING_FINDINGS")

    reviewed_catalog["review_summary"] = {
        "reviewer": review["model"],
        "overall_confidence": review["overall_confidence"],
        "finding_count": len(review["findings"]),
    }
    return {
        "review_status": review_status,
        "auto_verified": auto_verified,
        "catalog": reviewed_catalog,
        "validation": validation,
        "review": review,
        "warnings": warnings,
    }


def _normalize_model_review(model_review: dict[str, Any]) -> dict[str, Any]:
    model = model_review.get("model")
    if not isinstance(model, str) or not model.strip():
        raise _invalid_review("model_required")

    overall_confidence = model_review.get("overall_confidence")
    if (
        not isinstance(overall_confidence, (int, float))
        or isinstance(overall_confidence, bool)
        or not 0 <= overall_confidence <= 1
    ):
        raise _invalid_review("overall_confidence_must_be_between_0_and_1")

    findings = model_review.get("findings")
    if not isinstance(findings, list):
        raise _invalid_review("findings_must_be_list")

    normalized_findings = [_normalize_finding(finding, index) for index, finding in enumerate(findings)]
    return {
        "model": model.strip(),
        "overall_confidence": float(overall_confidence),
        "findings": normalized_findings,
    }


def _normalize_finding(finding: Any, index: int) -> dict[str, Any]:
    if not isinstance(finding, dict):
        raise _invalid_review("finding_must_be_object", {"index": index})

    severity = finding.get("severity")
    if severity not in {"low", "medium", "high", "blocking"}:
        raise _invalid_review("finding_severity_invalid", {"index": index})
    code = finding.get("code")
    message = finding.get("message")
    if not isinstance(code, str) or not code.strip() or not isinstance(message, str) or not message.strip():
        raise _invalid_review("finding_code_and_message_required", {"index": index})

    evidence = finding.get("evidence")
    if evidence is not None and not isinstance(evidence, dict):
        raise _invalid_review("finding_evidence_must_be_object", {"index": index})
    return {
        "code": code.strip(),
        "message": message.strip(),
        "severity": severity,
        "course_code": _optional_text(finding.get("course_code"), "course_code", index),
        "field": _optional_text(finding.get("field"), "field", index),
        "evidence": evidence,
    }


def _optional_text(value: Any, field: str, index: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise _invalid_review(f"finding_{field}_must_be_non_empty_string", {"index": index})
    return value.strip()


def _invalid_review(reason: str, details: dict[str, Any] | None = None) -> CatalogReviewError:
    return CatalogReviewError(
        code="INVALID_ARGUMENT",
        message="模型复核结果格式无效",
        details={"reason": reason, **(details or {})},
    )
