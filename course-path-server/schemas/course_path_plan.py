"""Course-path-plan-specific data structures.

The shared MCP response envelope is owned by the common schema module and will
wrap these tool-specific values after the RAG baseline is merged.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class CoursePathInput:
    major: str
    grade: str
    completed_courses: tuple[str, ...]
    target_course: str | None = None
    goal: str | None = None
    planned_courses: tuple[str, ...] = ()

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "CoursePathInput":
        """Validate untrusted MCP arguments and create a rule-engine input."""
        major = _required_text(payload, "major")
        grade = _required_text(payload, "grade")
        target_course = _optional_text(payload, "target_course")
        goal = _optional_text(payload, "goal")

        if target_course is None and goal is None:
            raise _invalid_argument("target_course_or_goal_required")
        if target_course is not None and goal is not None and target_course != goal:
            raise _invalid_argument("target_course_and_goal_conflict")

        return cls(
            major=major,
            grade=grade,
            completed_courses=_course_codes(payload.get("completed_courses"), "completed_courses", required=True),
            target_course=target_course,
            goal=goal,
            planned_courses=_course_codes(payload.get("planned_courses"), "planned_courses", required=False),
        )


@dataclass(frozen=True)
class CoursePathRuleError(Exception):
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


def _course_codes(value: Any, field: str, *, required: bool) -> tuple[str, ...]:
    if value is None:
        if required:
            raise _invalid_argument(f"{field}_required")
        return ()
    if not isinstance(value, list):
        raise _invalid_argument(f"{field}_must_be_list")

    codes: list[str] = []
    for index, course_code in enumerate(value):
        if not isinstance(course_code, str) or not course_code.strip():
            raise _invalid_argument(f"{field}_{index}_must_be_non_empty_string")
        normalized_code = course_code.strip()
        if normalized_code not in codes:
            codes.append(normalized_code)
    return tuple(codes)


def _invalid_argument(reason: str) -> CoursePathRuleError:
    return CoursePathRuleError(
        code="INVALID_ARGUMENT",
        message="参数错误",
        details={"reason": reason},
    )
