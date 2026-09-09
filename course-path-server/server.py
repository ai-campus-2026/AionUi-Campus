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
from tools.course_path_rules import build_course_path_data, load_course_catalog


PROJECT_ROOT = Path(__file__).resolve().parent
CATALOG_PATH = PROJECT_ROOT / "data" / "course_catalog.json"

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger("course_path_server")

mcp = FastMCP("course-path-server")


def handle_course_path_plan(payload: dict[str, Any]) -> dict[str, Any]:
    """Evaluate one request and always return the shared response envelope."""
    started_at = time.perf_counter()
    request_id = uuid4().hex
    meta = {"tool": "course_path_plan", "request_id": request_id}

    try:
        input_data = CoursePathInput.from_payload(payload)
        result = build_course_path_data(input_data, load_course_catalog(CATALOG_PATH))
        sources = result.pop("sources", [])
        warnings = result.pop("warnings", [])
        if result.get("data_status") != "verified":
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


@mcp.tool()
async def course_path_plan(
    major: str,
    grade: str,
    completed_courses: list[str],
    target_course: str | None = None,
    goal: str | None = None,
    planned_courses: list[str] | None = None,
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
        }
    )


def main() -> None:
    """Run the MCP server with the default stdio transport."""
    logger.info("course-path MCP server started with stdio transport")
    mcp.run()


if __name__ == "__main__":
    main()
