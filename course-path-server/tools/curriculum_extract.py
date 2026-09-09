"""Deterministic conversion of extracted TSV tables into catalog drafts."""

from __future__ import annotations

import csv
import re
from io import StringIO
from typing import Any

from schemas.curriculum_extract import CurriculumExtractError, CurriculumExtractInput


REQUIRED_COLUMNS = (
    "course_code",
    "course_name",
    "credits",
    "semester",
    "category",
    "prerequisites",
    "page",
    "section",
)


def extract_catalog_draft(input_data: CurriculumExtractInput) -> dict[str, Any]:
    """Parse a standard TSV curriculum table into an unpublished catalog draft."""
    reader = csv.DictReader(StringIO(input_data.course_table_tsv), delimiter="\t")
    if reader.fieldnames is None:
        raise _table_error("header_required")

    headers = tuple(header.strip() for header in reader.fieldnames if header is not None)
    missing_columns = [column for column in REQUIRED_COLUMNS if column not in headers]
    if missing_columns:
        raise _table_error("required_columns_missing", {"columns": missing_columns})

    courses: list[dict[str, Any]] = []
    for row_number, row in enumerate(reader, start=2):
        courses.append(_parse_course_row(row, row_number))

    if not courses:
        raise _table_error("course_rows_required")

    return {
        "catalog_id": input_data.catalog_id or _default_catalog_id(input_data),
        "data_status": "draft",
        "document": input_data.document,
        "major": input_data.major,
        "cohort": input_data.cohort,
        "version": input_data.version,
        "extraction_method": "tsv_table_import",
        "courses": courses,
    }


def _parse_course_row(row: dict[str | None, str | None], row_number: int) -> dict[str, Any]:
    values = {key.strip() if key is not None else "": (value or "").strip() for key, value in row.items()}
    missing_values = [column for column in ("course_code", "course_name", "credits", "semester", "category") if not values[column]]
    if missing_values:
        raise _table_error("course_values_missing", {"row": row_number, "columns": missing_values})

    return {
        "course_code": values["course_code"],
        "course_name": values["course_name"],
        "credits": _parse_credits(values["credits"], row_number),
        "semester": _parse_semester(values["semester"], row_number),
        "category": values["category"],
        "prerequisites": [code.strip() for code in values["prerequisites"].split("|") if code.strip()],
        "page": _parse_page(values["page"], row_number),
        "section": values["section"] or None,
    }


def _parse_credits(value: str, row_number: int) -> int | float:
    try:
        credits = float(value)
    except ValueError as error:
        raise _table_error("credits_invalid", {"row": row_number, "value": value}) from error
    if credits <= 0:
        raise _table_error("credits_invalid", {"row": row_number, "value": value})
    return int(credits) if credits.is_integer() else credits


def _parse_semester(value: str, row_number: int) -> int:
    try:
        semester = int(value)
    except ValueError as error:
        raise _table_error("semester_invalid", {"row": row_number, "value": value}) from error
    if semester <= 0:
        raise _table_error("semester_invalid", {"row": row_number, "value": value})
    return semester


def _parse_page(value: str, row_number: int) -> int | None:
    if not value:
        return None
    try:
        page = int(value)
    except ValueError as error:
        raise _table_error("page_invalid", {"row": row_number, "value": value}) from error
    if page <= 0:
        raise _table_error("page_invalid", {"row": row_number, "value": value})
    return page


def _default_catalog_id(input_data: CurriculumExtractInput) -> str:
    parts = (input_data.major, input_data.cohort, input_data.version)
    normalized = [re.sub(r"[^a-z0-9]+", "-", part.lower()).strip("-") for part in parts]
    return "-".join(normalized)


def _table_error(reason: str, details: dict[str, Any] | None = None) -> CurriculumExtractError:
    return CurriculumExtractError(
        code="INVALID_ARGUMENT",
        message="培养方案表格格式无效",
        details={"reason": reason, **(details or {})},
    )
