"""Input structures for transforming extracted curriculum tables into drafts."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class CurriculumExtractInput:
    """Metadata and TSV table text supplied by an OCR or manual extraction step."""

    document: str
    major: str
    cohort: str
    version: str
    course_table_tsv: str
    catalog_id: str | None = None

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "CurriculumExtractInput":
        return cls(
            document=_required_text(payload, "document"),
            major=_required_text(payload, "major"),
            cohort=_required_text(payload, "cohort"),
            version=_required_text(payload, "version"),
            course_table_tsv=_required_text(payload, "course_table_tsv"),
            catalog_id=_optional_text(payload, "catalog_id"),
        )


@dataclass(frozen=True)
class CurriculumExtractError(Exception):
    """A recoverable input or table-format error from curriculum extraction."""

    code: str
    message: str
    details: dict[str, Any]


def _required_text(payload: dict[str, Any], field: str) -> str:
    value = _optional_text(payload, field)
    if value is None:
        raise _invalid_argument(f"{field}_required")
    return value


def _optional_text(payload: dict[str, Any], field: str) -> str | None:
    value = payload.get(field)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise _invalid_argument(f"{field}_must_be_non_empty_string")
    return value.strip()


def _invalid_argument(reason: str) -> CurriculumExtractError:
    return CurriculumExtractError(
        code="INVALID_ARGUMENT",
        message="培养方案提取参数错误",
        details={"reason": reason},
    )
