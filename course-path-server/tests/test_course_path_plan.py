from __future__ import annotations

import anyio
from copy import deepcopy
from pathlib import Path
import sys

import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from schemas.course_path_plan import CoursePathInput, CoursePathRuleError
from schemas.catalog import CATALOG_REQUIRED_FIELDS, COURSE_REQUIRED_FIELDS
from schemas.common import error_response, success_response
from server import handle_course_path_plan
from tools.course_path_rules import build_course_path_data, load_course_catalog


CATALOG_PATH = PROJECT_ROOT / "data" / "course_catalog.json"


def load_catalog() -> dict[str, object]:
    return load_course_catalog(CATALOG_PATH)


def test_returns_eligible_when_all_prerequisites_are_completed() -> None:
    result = build_course_path_data(
        CoursePathInput(
            major="software-engineering",
            grade="2026",
            completed_courses=("SE101", "SE102", "SE201", "SE202", "SE301", "SE302"),
            target_course="SE401",
        ),
        load_catalog(),
    )

    assert result["basic_advice"]["status"] == "ELIGIBLE"


def test_reports_a_missing_direct_prerequisite() -> None:
    result = build_course_path_data(
        CoursePathInput(
            major="software-engineering",
            grade="2026",
            completed_courses=("SE101", "SE102", "SE201", "SE202", "SE301"),
            target_course="SE401",
        ),
        load_catalog(),
    )

    assert result["prerequisite_conflicts"][0]["missing_direct_prerequisites"][0]["course_code"] == "SE302"


def test_reports_missing_courses_across_the_prerequisite_chain() -> None:
    result = build_course_path_data(
        CoursePathInput(
            major="software-engineering",
            grade="2026",
            completed_courses=(),
            target_course="SE401",
        ),
        load_catalog(),
    )

    assert [course["course_code"] for course in result["missing_courses"]] == [
        "SE101",
        "SE102",
        "SE201",
        "SE202",
        "SE301",
        "SE302",
    ]


def test_checks_each_planned_course_for_direct_conflicts() -> None:
    result = build_course_path_data(
        CoursePathInput(
            major="software-engineering",
            grade="2026",
            completed_courses=(),
            target_course="SE401",
            planned_courses=("SE201", "SE302"),
        ),
        load_catalog(),
    )

    assert [conflict["course"]["course_code"] for conflict in result["prerequisite_conflicts"]] == ["SE201", "SE302"]


def test_warns_without_rejecting_an_unknown_completed_course() -> None:
    result = build_course_path_data(
        CoursePathInput(
            major="software-engineering",
            grade="2026",
            completed_courses=("UNKNOWN",),
            target_course="SE401",
        ),
        load_catalog(),
    )

    assert result["warnings"] == ["UNKNOWN_COMPLETED_COURSE:UNKNOWN"]


@pytest.mark.parametrize(
    ("input_data", "code"),
    [
        (CoursePathInput(major="", grade="2026", completed_courses=(), target_course="SE401"), "INVALID_ARGUMENT"),
        (CoursePathInput(major="software-engineering", grade="2026", completed_courses=()), "INVALID_ARGUMENT"),
        (CoursePathInput(major="software-engineering", grade="2026", completed_courses=(), target_course="UNKNOWN"), "COURSE_NOT_FOUND"),
        (CoursePathInput(major="unknown-major", grade="2026", completed_courses=(), target_course="SE401"), "COURSE_NOT_FOUND"),
    ],
)
def test_returns_structured_errors_for_invalid_requests(input_data: CoursePathInput, code: str) -> None:
    with pytest.raises(CoursePathRuleError) as error:
        build_course_path_data(input_data, load_catalog())

    assert error.value.code == code


def test_detects_a_prerequisite_cycle() -> None:
    catalog = deepcopy(load_catalog())
    catalog["courses"] = [
        {
            "course_code": "A",
            "course_name": "A",
            "credits": 1,
            "semester": 1,
            "category": "test",
            "prerequisites": ["B"],
        },
        {
            "course_code": "B",
            "course_name": "B",
            "credits": 1,
            "semester": 1,
            "category": "test",
            "prerequisites": ["A"],
        },
    ]

    with pytest.raises(CoursePathRuleError) as error:
        build_course_path_data(
            CoursePathInput(major="software-engineering", grade="2026", completed_courses=(), target_course="A"),
            catalog,
        )

    assert error.value.code == "INTERNAL_ERROR"


def test_detects_a_missing_prerequisite_definition() -> None:
    catalog = deepcopy(load_catalog())
    catalog["courses"] = [
        {
            "course_code": "A",
            "course_name": "A",
            "credits": 1,
            "semester": 1,
            "category": "test",
            "prerequisites": ["MISSING"],
        }
    ]

    with pytest.raises(CoursePathRuleError) as error:
        build_course_path_data(
            CoursePathInput(major="software-engineering", grade="2026", completed_courses=(), target_course="A"),
            catalog,
        )

    assert error.value.code == "COURSE_NOT_FOUND"


def test_uses_goal_as_a_target_course_alias() -> None:
    result = build_course_path_data(
        CoursePathInput(
            major="software-engineering",
            grade="2026",
            completed_courses=("SE101", "SE102", "SE201", "SE202", "SE301"),
            goal="SE401",
        ),
        load_catalog(),
    )

    assert result["basic_advice"]["status"] == "NOT_ELIGIBLE"


def test_includes_mock_data_status_and_source() -> None:
    result = build_course_path_data(
        CoursePathInput(
            major="software-engineering",
            grade="2026",
            completed_courses=(),
            target_course="SE401",
        ),
        load_catalog(),
    )

    assert result["data_status"] == "mock"
    assert result["sources"][0]["document"] == "软件工程专业培养方案（公开样例）"
    assert result["catalog"] == {
        "catalog_id": "software-engineering-2026-v1",
        "major": "software-engineering",
        "cohort": "2026",
        "version": "2026.1",
    }


def test_mock_catalog_matches_the_versioned_catalog_contract() -> None:
    catalog = load_catalog()

    assert set(CATALOG_REQUIRED_FIELDS).issubset(catalog)
    assert catalog["data_status"] == "mock"
    for course in catalog["courses"]:
        assert set(COURSE_REQUIRED_FIELDS).issubset(course)


def test_builds_the_shared_success_response() -> None:
    response = success_response({"basic_advice": {"status": "ELIGIBLE"}}, meta={"tool": "course_path_plan"})

    assert response["schema_version"] == "0.1"
    assert response["ok"] is True
    assert response["error"] is None
    assert response["data"]["basic_advice"]["status"] == "ELIGIBLE"


def test_builds_the_shared_error_response() -> None:
    response = error_response("INVALID_ARGUMENT", "参数错误", details={"reason": "grade_required"})

    assert response["schema_version"] == "0.1"
    assert response["ok"] is False
    assert response["data"] is None
    assert response["error"] == {
        "code": "INVALID_ARGUMENT",
        "message": "参数错误",
        "details": {"reason": "grade_required"},
    }


def test_validates_the_mcp_payload_before_running_rules() -> None:
    with pytest.raises(CoursePathRuleError) as error:
        CoursePathInput.from_payload(
            {
                "major": "software-engineering",
                "grade": "2026",
                "completed_courses": [],
            }
        )

    assert error.value.code == "INVALID_ARGUMENT"
    assert error.value.details == {"reason": "target_course_or_goal_required"}


def test_server_returns_the_shared_envelope_for_a_course_conflict() -> None:
    response = handle_course_path_plan(
        {
            "major": "software-engineering",
            "grade": "2026",
            "completed_courses": ["SE101", "SE102", "SE201", "SE202", "SE301"],
            "target_course": "SE401",
        }
    )

    assert response["ok"] is True
    assert response["data"]["basic_advice"]["status"] == "NOT_ELIGIBLE"
    assert response["data"]["prerequisite_conflicts"][0]["course"]["course_code"] == "SE401"
    assert response["meta"]["tool"] == "course_path_plan"


def test_server_returns_a_structured_error_for_invalid_arguments() -> None:
    response = handle_course_path_plan(
        {
            "major": "software-engineering",
            "grade": "2026",
            "completed_courses": [],
        }
    )

    assert response["ok"] is False
    assert response["data"] is None
    assert response["error"]["code"] == "INVALID_ARGUMENT"
    assert response["meta"]["tool"] == "course_path_plan"


def test_server_exposes_and_calls_the_tool_over_stdio() -> None:
    async def call_tool() -> None:
        parameters = StdioServerParameters(
            command=sys.executable,
            args=["server.py"],
            cwd=PROJECT_ROOT,
        )
        async with stdio_client(parameters) as (read_stream, write_stream):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                tools = await session.list_tools()
                assert [tool.name for tool in tools.tools] == ["course_path_plan"]

                result = await session.call_tool(
                    "course_path_plan",
                    arguments={
                        "major": "software-engineering",
                        "grade": "2026",
                        "completed_courses": ["SE101", "SE102", "SE201", "SE202", "SE301"],
                        "target_course": "SE401",
                    },
                )
                assert result.isError is False
                assert result.structuredContent is not None
                assert result.structuredContent["ok"] is True
                assert result.structuredContent["data"]["basic_advice"]["status"] == "NOT_ELIGIBLE"

    anyio.run(call_tool)
