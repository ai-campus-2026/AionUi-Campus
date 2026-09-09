"""Deterministic prerequisite checks for the course_path_plan MCP tool."""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from schemas.course_path_plan import CoursePathInput, CoursePathRuleError


def load_course_catalog(path: Path) -> dict[str, Any]:
    """Load a course catalog while keeping file I/O outside rule evaluation."""
    with path.open(encoding="utf-8") as catalog_file:
        catalog = json.load(catalog_file)
    if not isinstance(catalog, dict) or not isinstance(catalog.get("courses"), list):
        raise CoursePathRuleError(
            code="INTERNAL_ERROR",
            message="课程目录格式无效",
            details={"reason": "catalog_requires_courses"},
        )
    return catalog


def _course_index(catalog: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    courses = catalog.get("courses")
    if not isinstance(courses, list):
        raise CoursePathRuleError(
            code="INTERNAL_ERROR",
            message="课程目录缺少课程列表",
            details={"reason": "courses_missing"},
        )

    index: dict[str, dict[str, Any]] = {}
    for course in courses:
        if not isinstance(course, dict) or not isinstance(course.get("course_code"), str):
            raise CoursePathRuleError(
                code="INTERNAL_ERROR",
                message="课程目录包含无效课程记录",
                details={"reason": "course_code_missing"},
            )
        index[course["course_code"]] = course
    return index


def _required_courses(
    course_code: str,
    courses: Mapping[str, dict[str, Any]],
    visiting: set[str],
    visited: set[str],
) -> set[str]:
    if course_code in visiting:
        raise CoursePathRuleError(
            code="INTERNAL_ERROR",
            message="课程先修关系存在环",
            details={"course_code": course_code, "reason": "prerequisite_cycle"},
        )
    if course_code in visited:
        return {course_code}
    course = courses.get(course_code)
    if course is None:
        raise CoursePathRuleError(
            code="COURSE_NOT_FOUND",
            message="课程目录中未找到课程",
            details={"course_code": course_code},
        )

    prerequisites = course.get("prerequisites", [])
    if not isinstance(prerequisites, list) or not all(isinstance(code, str) for code in prerequisites):
        raise CoursePathRuleError(
            code="INTERNAL_ERROR",
            message="课程先修关系格式无效",
            details={"course_code": course_code, "reason": "invalid_prerequisites"},
        )

    visiting.add(course_code)
    required = {course_code}
    for prerequisite_code in prerequisites:
        required.update(_required_courses(prerequisite_code, courses, visiting, visited))
    visiting.remove(course_code)
    visited.add(course_code)
    return required


def _course_source(catalog: Mapping[str, Any], target_course: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "document": catalog.get("document"),
        "section": target_course.get("section"),
        "page": target_course.get("page"),
        "content": None,
        "chunk_index": None,
        "score": None,
    }


def build_course_path_data(input_data: CoursePathInput, catalog: Mapping[str, Any]) -> dict[str, Any]:
    """Return tool-specific course planning data without MCP transport concerns."""
    if not input_data.major.strip() or not input_data.grade.strip():
        raise CoursePathRuleError(
            code="INVALID_ARGUMENT",
            message="专业和年级不能为空",
            details={},
        )
    if input_data.major != catalog.get("major"):
        raise CoursePathRuleError(
            code="COURSE_NOT_FOUND",
            message="未找到该专业的课程目录",
            details={"major": input_data.major},
        )

    target_code = (input_data.target_course or input_data.goal or "").strip()
    if not target_code:
        raise CoursePathRuleError(
            code="INVALID_ARGUMENT",
            message="必须提供目标课程或课程目标",
            details={"required": "target_course_or_goal"},
        )

    courses = _course_index(catalog)
    target_course = courses.get(target_code)
    if target_course is None:
        raise CoursePathRuleError(
            code="COURSE_NOT_FOUND",
            message="未找到目标课程",
            details={"course_code": target_code},
        )

    completed = set(input_data.completed_courses)
    warnings = [
        f"UNKNOWN_COMPLETED_COURSE:{course_code}"
        for course_code in input_data.completed_courses
        if course_code not in courses
    ]
    required_codes = _required_courses(target_code, courses, set(), set())
    missing_codes = sorted(
        required_codes - completed - {target_code},
        key=lambda course_code: (courses[course_code]["semester"], course_code),
    )
    missing_courses = [courses[course_code] for course_code in missing_codes]

    planned_codes = input_data.planned_courses or (target_code,)
    conflicts = []
    for planned_code in planned_codes:
        planned_course = courses.get(planned_code)
        if planned_course is None:
            warnings.append(f"UNKNOWN_PLANNED_COURSE:{planned_code}")
            continue
        missing_direct = [
            courses[course_code]
            for course_code in planned_course["prerequisites"]
            if course_code not in completed
        ]
        if missing_direct:
            conflicts.append(
                {
                    "course": planned_course,
                    "missing_direct_prerequisites": missing_direct,
                }
            )

    has_conflicts = bool(conflicts)
    return {
        "missing_courses": missing_courses,
        "prerequisite_conflicts": conflicts,
        "basic_advice": {
            "status": "NOT_ELIGIBLE" if has_conflicts else "ELIGIBLE",
            "next_actions": [
                "COMPLETE_DIRECT_PREREQUISITES" if has_conflicts else "TARGET_COURSE_CAN_BE_TAKEN"
            ],
            "recommended_courses": missing_courses,
        },
        "candidate_paths": [],
        "semester_plan": [],
        "additional_courses": missing_courses,
        "risks": ["PREREQUISITE_NOT_MET"] if has_conflicts else [],
        "warnings": warnings,
        "sources": [_course_source(catalog, target_course)],
        "data_status": catalog.get("data_status"),
    }
