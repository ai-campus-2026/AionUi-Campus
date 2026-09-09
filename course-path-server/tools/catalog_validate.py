"""Read-only validation for extracted or manually entered course catalogs."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from schemas.catalog import CATALOG_REQUIRED_FIELDS, COURSE_REQUIRED_FIELDS


def validate_catalog(catalog: Mapping[str, Any]) -> dict[str, Any]:
    """Validate catalog structure and prerequisite integrity without changing data."""
    errors: list[dict[str, Any]] = []
    warnings: list[str] = []

    _validate_catalog_fields(catalog, errors)
    courses = catalog.get("courses")
    if not isinstance(courses, list):
        return _validation_result(errors, warnings, 0)

    course_index = _validate_courses(courses, errors, warnings)
    _validate_prerequisite_references(course_index, errors)
    _validate_prerequisite_cycles(course_index, errors)
    _warn_on_catalog_status(catalog, warnings)

    return _validation_result(errors, warnings, len(courses))


def _validate_catalog_fields(catalog: Mapping[str, Any], errors: list[dict[str, Any]]) -> None:
    for field in CATALOG_REQUIRED_FIELDS:
        value = catalog.get(field)
        if value is None or (isinstance(value, str) and not value.strip()):
            _add_error(errors, "CATALOG_FIELD_REQUIRED", f"catalog.{field}", {"field": field})

    if catalog.get("data_status") not in {"draft", "verified", "mock"}:
        _add_error(errors, "CATALOG_STATUS_INVALID", "catalog.data_status", {"value": catalog.get("data_status")})

    if not isinstance(catalog.get("courses"), list):
        _add_error(errors, "CATALOG_COURSES_INVALID", "catalog.courses", {})


def _validate_courses(
    courses: list[Any], errors: list[dict[str, Any]], warnings: list[str]
) -> dict[str, dict[str, Any]]:
    course_index: dict[str, dict[str, Any]] = {}
    for index, course in enumerate(courses):
        path = f"courses[{index}]"
        if not isinstance(course, dict):
            _add_error(errors, "COURSE_RECORD_INVALID", path, {})
            continue

        for field in COURSE_REQUIRED_FIELDS:
            if field not in course:
                _add_error(errors, "COURSE_FIELD_REQUIRED", f"{path}.{field}", {"field": field})

        for field in ("course_code", "course_name", "credits", "semester", "category", "prerequisites"):
            if course.get(field) is None:
                _add_error(errors, "COURSE_FIELD_REQUIRED", f"{path}.{field}", {"field": field})

        course_code = course.get("course_code")
        if not isinstance(course_code, str) or not course_code.strip():
            _add_error(errors, "COURSE_CODE_INVALID", f"{path}.course_code", {})
            continue
        if course_code in course_index:
            _add_error(errors, "COURSE_CODE_DUPLICATE", f"{path}.course_code", {"course_code": course_code})
            continue
        course_index[course_code] = course

        credits = course.get("credits")
        if not isinstance(credits, (int, float)) or isinstance(credits, bool) or credits <= 0:
            _add_error(errors, "COURSE_CREDITS_INVALID", f"{path}.credits", {"course_code": course_code})
        semester = course.get("semester")
        if not isinstance(semester, int) or isinstance(semester, bool) or semester <= 0:
            _add_error(errors, "COURSE_SEMESTER_INVALID", f"{path}.semester", {"course_code": course_code})
        if not isinstance(course.get("prerequisites"), list) or not all(
            isinstance(code, str) and code.strip() for code in course.get("prerequisites", [])
        ):
            _add_error(errors, "COURSE_PREREQUISITES_INVALID", f"{path}.prerequisites", {"course_code": course_code})
        if course.get("page") is None and course.get("section") is None:
            warnings.append(f"COURSE_SOURCE_LOCATION_MISSING:{course_code}")
    return course_index


def _validate_prerequisite_references(course_index: Mapping[str, dict[str, Any]], errors: list[dict[str, Any]]) -> None:
    for course_code, course in course_index.items():
        prerequisites = course.get("prerequisites")
        if not isinstance(prerequisites, list):
            continue
        for prerequisite_code in prerequisites:
            if prerequisite_code not in course_index:
                _add_error(
                    errors,
                    "PREREQUISITE_NOT_FOUND",
                    f"courses[{course_code}].prerequisites",
                    {"course_code": course_code, "prerequisite_code": prerequisite_code},
                )
                continue
            prerequisite_semester = course_index[prerequisite_code].get("semester")
            course_semester = course.get("semester")
            if isinstance(prerequisite_semester, int) and isinstance(course_semester, int) and prerequisite_semester >= course_semester:
                _add_error(
                    errors,
                    "PREREQUISITE_SEMESTER_INVALID",
                    f"courses[{course_code}].prerequisites",
                    {"course_code": course_code, "prerequisite_code": prerequisite_code},
                )


def _validate_prerequisite_cycles(course_index: Mapping[str, dict[str, Any]], errors: list[dict[str, Any]]) -> None:
    visiting: set[str] = set()
    visited: set[str] = set()
    cycles: set[str] = set()

    def visit(course_code: str) -> None:
        if course_code in visiting:
            cycles.add(course_code)
            return
        if course_code in visited:
            return
        visiting.add(course_code)
        prerequisites = course_index[course_code].get("prerequisites")
        if isinstance(prerequisites, list):
            for prerequisite_code in prerequisites:
                if prerequisite_code in course_index:
                    visit(prerequisite_code)
        visiting.remove(course_code)
        visited.add(course_code)

    for course_code in course_index:
        visit(course_code)
    for course_code in sorted(cycles):
        _add_error(errors, "PREREQUISITE_CYCLE", f"courses[{course_code}].prerequisites", {"course_code": course_code})


def _warn_on_catalog_status(catalog: Mapping[str, Any], warnings: list[str]) -> None:
    status = catalog.get("data_status")
    if status != "verified":
        warnings.append(f"CATALOG_NOT_VERIFIED:{status}")


def _validation_result(errors: list[dict[str, Any]], warnings: list[str], course_count: int) -> dict[str, Any]:
    return {
        "valid": not errors,
        "course_count": course_count,
        "errors": errors,
        "warnings": warnings,
    }


def _add_error(errors: list[dict[str, Any]], code: str, path: str, details: dict[str, Any]) -> None:
    errors.append({"code": code, "path": path, "details": details})
