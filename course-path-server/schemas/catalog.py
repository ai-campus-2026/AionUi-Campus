"""Data contract for versioned course catalogs.

Validation rules are implemented separately so this module remains the single
source of truth for the catalog shape used by extraction, review, and planning.
"""

from __future__ import annotations

from typing import Literal, NotRequired, TypedDict


CatalogStatus = Literal["draft", "auto_verified", "verified", "official", "mock"]

CATALOG_REQUIRED_FIELDS = (
    "catalog_id",
    "data_status",
    "document",
    "major",
    "cohort",
    "version",
    "courses",
)

COURSE_REQUIRED_FIELDS = (
    "course_code",
    "course_name",
    "credits",
    "semester",
    "category",
    "prerequisites",
    "page",
    "section",
)


class CourseRecord(TypedDict):
    """One course record used by prerequisite and degree-planning rules."""

    course_code: str
    course_name: str
    credits: int | float
    semester: int
    category: str
    prerequisites: list[str]
    page: int | None
    section: str | None


class CourseCatalog(TypedDict):
    """A complete catalog for one major, cohort, and curriculum version."""

    catalog_id: str
    data_status: CatalogStatus
    document: str
    major: str
    cohort: str
    version: str
    courses: list[CourseRecord]
    extraction_method: NotRequired[str]
    reviewed_by: NotRequired[str]
    reviewed_at: NotRequired[str]
    review_summary: NotRequired[dict[str, object]]
