from __future__ import annotations

import anyio
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import httpx
import os
from pathlib import Path
import socket
import ssl
import sys
from types import SimpleNamespace

import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from schemas.course_path_plan import CoursePathInput, CoursePathRuleError
from schemas.catalog import CATALOG_REQUIRED_FIELDS, COURSE_REQUIRED_FIELDS
from schemas.common import error_response, success_response
from server import handle_course_path_plan
from server import handle_catalog_validate
from server import handle_curriculum_extract
from server import handle_catalog_review
from server import handle_curriculum_extract_from_attachment
from server import handle_curriculum_ingest_from_attachment
from server import handle_curriculum_index_document
from server import handle_retry_curriculum_extraction
from server import handle_curriculum_model_check
from server import handle_list_curriculum_documents
from server import handle_get_curriculum_document
from server import handle_clear_curriculum_knowledge_base
from server import configured_directory
from tools.course_path_rules import build_course_path_data, load_course_catalog
from tools.catalog_validate import validate_catalog
from tools.curriculum_extract import extract_catalog_draft
from schemas.curriculum_extract import CurriculumExtractError, CurriculumExtractInput
from schemas.catalog_review import CatalogReviewError, CatalogReviewInput
from schemas.attachment_extract import AttachmentExtractError, AttachmentExtractInput
from tools.catalog_review import review_catalog
from tools.attachment_validation import inspect_attachment
import tools.attachment_extract as attachment_extract
from tools.attachment_extract import _select_course_table_pages, cleanup_stale_temporary_workspaces
from tools.curriculum_store import CurriculumKnowledgeStore, CurriculumStoreError
import tools.dashscope_client as dashscope_client
from tools.dashscope_client import DashScopeClient, DashScopeConfig, DashScopeError, _network_error_reason


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


def test_course_path_plan_accepts_a_valid_attachment_without_persisting_it(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    attachment = tmp_path / "curriculum.pdf"
    attachment.write_bytes(b"curriculum document")

    response = handle_course_path_plan(
        {
            "major": "software-engineering",
            "grade": "2026",
            "completed_courses": [],
            "target_course": "SE401",
            "attachment_path": str(attachment),
        }
    )

    assert response["ok"] is True
    assert response["data"]["attachment"]["status"] == "VALID"
    assert "attachment_path" not in response["data"]["attachment"]


def test_course_path_plan_keeps_working_when_an_attachment_is_rejected(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    response = handle_course_path_plan(
        {
            "major": "software-engineering",
            "grade": "2026",
            "completed_courses": [],
            "target_course": "SE401",
            "attachment_path": str(tmp_path / "missing.pdf"),
        }
    )

    assert response["ok"] is True
    assert response["data"]["attachment"] == {"status": "REJECTED", "reason": "ATTACHMENT_NOT_FOUND"}
    assert "ATTACHMENT_NOT_FOUND" in response["warnings"]


def test_attachment_accepts_an_explicit_local_pdf_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    attachment = tmp_path / "curriculum.pdf"
    attachment.write_bytes(b"curriculum document")

    inspection = inspect_attachment(str(attachment))

    assert inspection is not None
    assert inspection["status"] == "VALID"


def test_attachment_accepts_a_windows_verbatim_file_path(tmp_path: Path) -> None:
    attachment = tmp_path / "curriculum.pdf"
    attachment.write_bytes(b"curriculum document")

    inspection = inspect_attachment("\\\\?\\" + str(attachment))

    assert inspection is not None
    assert inspection["status"] == "VALID"


def test_attachment_rejects_unapproved_file_types(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    attachment = tmp_path / "curriculum.txt"
    attachment.write_text("not an approved attachment", encoding="utf-8")

    assert inspect_attachment(str(attachment)) == {
        "status": "REJECTED",
        "reason": "ATTACHMENT_TYPE_UNSUPPORTED",
    }


def test_attachment_extraction_returns_model_not_configured_without_a_local_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    attachment = tmp_path / "curriculum.png"
    attachment.write_bytes(b"image")
    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)

    response = handle_curriculum_extract_from_attachment(
        {
            "attachment_path": str(attachment),
            "major": "software-engineering",
            "cohort": "2026",
            "version": "2026.1",
        }
    )

    assert response["ok"] is False
    assert response["error"]["code"] == "MODEL_NOT_CONFIGURED"
    assert response["meta"]["tool"] == "curriculum_extract_from_attachment"


def test_attachment_extraction_builds_a_transient_reviewed_catalog(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    attachment = tmp_path / "curriculum.png"
    attachment.write_bytes(b"image")

    class FakeDashScopeClient:
        def __init__(self, _config: object) -> None:
            pass

        def extract_course_records(self, _images: list[dict[str, object]]) -> str:
            return json.dumps(
                {
                    "courses": [
                        {
                            "course_code": "SE101",
                            "course_name": "程序设计基础",
                            "credits": 3,
                            "semester": 1,
                            "category": "专业基础课",
                            "prerequisites": [],
                            "page": 1,
                            "section": "课程设置",
                        },
                        {
                            "course_code": "SE201",
                            "course_name": "数据结构",
                            "credits": 4,
                            "semester": 2,
                            "category": "专业核心课",
                            "prerequisites": ["SE101"],
                            "page": 2,
                            "section": "课程设置",
                        },
                    ]
                },
                ensure_ascii=False,
            )

        def review_catalog(self, _images: list[dict[str, object]], _catalog: dict[str, object]) -> dict[str, object]:
            return _model_review()

    monkeypatch.setattr(attachment_extract, "DashScopeClient", FakeDashScopeClient)
    response = handle_curriculum_extract_from_attachment(
        {
            "attachment_path": str(attachment),
            "major": "software-engineering",
            "cohort": "2026",
            "version": "2026.1",
        }
    )

    assert response["ok"] is True
    assert response["data"]["catalog"]["data_status"] == "auto_verified"
    assert response["data"]["catalog"]["extraction_method"] == "multi_engine_text_then_visual_fallback"
    assert response["data"]["review"]["auto_verified"] is True
    assert "CATALOG_NOT_PERSISTED" in response["warnings"]


def test_attachment_extraction_repairs_only_a_page_with_missing_required_values(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    attachment = tmp_path / "curriculum.png"
    attachment.write_bytes(b"image")
    calls: list[str] = []

    class FakeDashScopeClient:
        def __init__(self, _config: object) -> None:
            pass

        def extract_course_records(self, _images: list[dict[str, object]]) -> str:
            calls.append("extract")
            return json.dumps(
                {
                    "courses": [
                        {
                            "course_code": "SE101",
                            "course_name": "程序设计基础",
                            "credits": None,
                            "semester": None,
                            "category": "专业基础课",
                            "prerequisites": [],
                            "page": 1,
                            "section": "课程设置",
                        }
                    ]
                },
                ensure_ascii=False,
            )

        def repair_course_records(self, _images: list[dict[str, object]], issue: dict[str, object]) -> str:
            calls.append("repair")
            assert issue["reason"] == "course_values_missing"
            assert issue["columns"] == ["credits", "semester"]
            return json.dumps(
                {
                    "courses": [
                        {
                            "course_code": "SE101",
                            "course_name": "程序设计基础",
                            "credits": 3,
                            "semester": 1,
                            "category": "专业基础课",
                            "prerequisites": [],
                            "page": 1,
                            "section": "课程设置",
                        }
                    ]
                },
                ensure_ascii=False,
            )

        def review_catalog(self, _images: list[dict[str, object]], _catalog: dict[str, object]) -> dict[str, object]:
            return _model_review()

    monkeypatch.setattr(attachment_extract, "DashScopeClient", FakeDashScopeClient)
    response = handle_curriculum_extract_from_attachment(
        {
            "attachment_path": str(attachment),
            "major": "software-engineering",
            "cohort": "2026",
            "version": "2026.1",
        }
    )

    assert response["ok"] is True
    assert calls == ["extract", "repair"]
    assert response["data"]["catalog"]["courses"][0]["credits"] == 3


def test_attachment_extraction_retains_an_incomplete_row_after_one_unsuccessful_repair(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    attachment = tmp_path / "curriculum.png"
    attachment.write_bytes(b"image")
    calls: list[str] = []
    invalid_response = json.dumps(
        {
            "courses": [
                {
                    "course_code": "SE101",
                    "course_name": "程序设计基础",
                    "credits": None,
                    "semester": None,
                    "category": "专业基础课",
                    "prerequisites": [],
                    "page": 1,
                    "section": "课程设置",
                }
            ]
        },
        ensure_ascii=False,
    )

    class FakeDashScopeClient:
        def __init__(self, _config: object) -> None:
            pass

        def extract_course_records(self, _images: list[dict[str, object]]) -> str:
            calls.append("extract")
            return invalid_response

        def repair_course_records(self, _images: list[dict[str, object]], _issue: dict[str, object]) -> str:
            calls.append("repair")
            return invalid_response

    monkeypatch.setattr(attachment_extract, "DashScopeClient", FakeDashScopeClient)
    response = handle_curriculum_extract_from_attachment(
        {
            "attachment_path": str(attachment),
            "major": "software-engineering",
            "cohort": "2026",
            "version": "2026.1",
        }
    )

    assert response["ok"] is True
    assert calls == ["extract", "repair"]
    assert response["data"]["catalog"]["courses"][0]["credits"] is None
    assert response["data"]["catalog"]["courses"][0]["semester"] is None
    assert response["data"]["validation"]["valid"] is False
    assert response["data"]["extraction_summary"]["status"] == "EXTRACTION_PARTIAL"
    assert "CURRICULUM_EXTRACTION_PARTIAL" in response["warnings"]


def test_pdf_native_text_is_extracted_before_using_a_page_image() -> None:
    page = attachment_extract._VisualPage(
        number=6,
        image={"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}},
        source_text="课程号 课程名称 学分 开课学期 修读要求\nA2040200 数据结构 3 3 必修",
    )
    request_inputs: list[list[dict[str, object]]] = []

    class FakeDashScopeClient:
        def extract_course_records(self, source_inputs: list[dict[str, object]]) -> str:
            request_inputs.append(source_inputs)
            return json.dumps(
                {
                    "courses": [
                        {
                            "course_code": "A2040200",
                            "course_name": "数据结构",
                            "credits": 3,
                            "semester": 3,
                            "category": "必修",
                            "prerequisites": [],
                            "page": None,
                            "section": None,
                        }
                    ]
                },
                ensure_ascii=False,
            )

    catalog = attachment_extract._extract_page_catalog(
        FakeDashScopeClient(),
        page,
        AttachmentExtractInput(
            attachment_path="D:/CampusFiles/curriculum.pdf",
            major="computer-science",
            cohort="2026",
            version="2026.1",
        ),
    )

    assert len(request_inputs) == 1
    assert all(item["type"] == "text" for item in request_inputs[0])
    assert catalog["courses"][0]["page"] == 6


def test_pdf_page_falls_back_to_its_image_only_after_text_attempts_fail() -> None:
    page = attachment_extract._VisualPage(
        number=6,
        image={"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}},
        source_text="课程号 课程名称 学分 开课学期 修读要求\nA2040200 数据结构 3 3 必修",
    )
    request_kinds: list[str] = []
    invalid = json.dumps(
        {
            "courses": [
                {
                    "course_code": "A2040200",
                    "course_name": "数据结构",
                    "credits": None,
                    "semester": None,
                    "category": "必修",
                    "prerequisites": [],
                    "page": 6,
                    "section": None,
                }
            ]
        },
        ensure_ascii=False,
    )
    valid = invalid.replace('"credits": null, "semester": null', '"credits": 3, "semester": 3')

    class FakeDashScopeClient:
        def extract_course_records(self, source_inputs: list[dict[str, object]]) -> str:
            is_visual = any(item["type"] == "image_url" for item in source_inputs)
            request_kinds.append("visual" if is_visual else "text")
            return valid if is_visual else invalid

        def repair_course_records(self, source_inputs: list[dict[str, object]], _issue: dict[str, object]) -> str:
            assert all(item["type"] == "text" for item in source_inputs)
            request_kinds.append("text-repair")
            return invalid

    catalog = attachment_extract._extract_page_catalog(
        FakeDashScopeClient(),
        page,
        AttachmentExtractInput(
            attachment_path="D:/CampusFiles/curriculum.pdf",
            major="computer-science",
            cohort="2026",
            version="2026.1",
        ),
    )

    assert request_kinds == ["text", "text-repair", "visual"]
    assert catalog["courses"][0]["credits"] == 3


def test_one_failed_pdf_page_keeps_successful_courses_and_evidence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    attachment = tmp_path / "curriculum.pdf"
    attachment.write_bytes(b"pdf")
    pages = [
        attachment_extract._VisualPage(
            number=5,
            image={"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}},
            source_text="课程号 课程名称 学分 开课学期 修读要求\nA1040020 计算机科学导论 2 1 必修",
        ),
        attachment_extract._VisualPage(
            number=6,
            image={"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}},
            source_text="课程号 课程名称 学分 开课学期 修读要求\nA2040200 数据结构 3 3 必修",
        ),
    ]

    @contextmanager
    def fake_visual_inputs(_attachment: Path, _max_pdf_pages: int):
        yield pages

    class FakeDashScopeClient:
        def __init__(self, _config: object) -> None:
            pass

        def extract_course_records(self, source_inputs: list[dict[str, object]]) -> str:
            source_text = str(source_inputs[0]["text"])
            if "page 6" in source_text:
                raise DashScopeError(
                    "MODEL_REQUEST_FAILED",
                    "模型请求失败",
                    {"reason": "connection_failed", "attempts": 3},
                )
            return json.dumps(
                {
                    "courses": [
                        {
                            "course_code": "A1040020",
                            "course_name": "计算机科学导论",
                            "credits": 2,
                            "semester": 1,
                            "category": "必修",
                            "prerequisites": [],
                            "page": 5,
                            "section": "课程设置",
                        }
                    ]
                },
                ensure_ascii=False,
            )

    monkeypatch.setattr(attachment_extract, "_visual_inputs", fake_visual_inputs)
    monkeypatch.setattr(attachment_extract, "DashScopeClient", FakeDashScopeClient)
    monkeypatch.setattr(attachment_extract, "NATIVE_TEXT_BATCH_CHARACTERS", 1)

    response = handle_curriculum_extract_from_attachment(
        {
            "attachment_path": str(attachment),
            "major": "computer-science",
            "cohort": "2026",
            "version": "2026.1",
        }
    )

    assert response["ok"] is True
    assert response["data"]["extraction_summary"]["status"] == "EXTRACTION_PARTIAL"
    assert response["data"]["extraction_summary"]["pages_attempted"] == [5, 6]
    assert response["data"]["extraction_summary"]["pages_succeeded"] == [5]
    assert response["data"]["extraction_summary"]["pages_failed"][0]["page"] == 6
    assert response["data"]["catalog"]["courses"][0]["course_code"] == "A1040020"
    assert response["sources"][0]["document"] == "curriculum.pdf"
    assert response["sources"][0]["page"] == 5


def test_native_pdf_pages_are_extracted_separately_to_limit_response_size() -> None:
    pages = [
        attachment_extract._VisualPage(
            number=5,
            image={"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}},
            source_text="A1040020 计算机科学导论 2 1 必修",
        ),
        attachment_extract._VisualPage(
            number=6,
            image={"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}},
            source_text="A2040200 数据结构 3 3 必修",
        ),
    ]
    calls: list[list[dict[str, object]]] = []

    class FakeDashScopeClient:
        def extract_course_records(self, source_inputs: list[dict[str, object]]) -> str:
            calls.append(source_inputs)
            is_first_page = "page 5" in str(source_inputs[0]["text"])
            return json.dumps(
                {
                    "courses": [
                        {
                            "course_code": "A1040020" if is_first_page else "A2040200",
                            "course_name": "计算机科学导论" if is_first_page else "数据结构",
                            "credits": 2 if is_first_page else 3,
                            "semester": 1 if is_first_page else 3,
                            "category": "必修",
                            "prerequisites": [],
                            "page": 5 if is_first_page else 6,
                            "section": "课程设置",
                        },
                    ]
                },
                ensure_ascii=False,
            )

    catalogs, successful, failed, first_error = attachment_extract._extract_selected_pages(
        FakeDashScopeClient(),
        pages,
        AttachmentExtractInput(
            attachment_path="D:/CampusFiles/curriculum.pdf",
            major="computer-science",
            cohort="2026",
            version="2026.1",
        ),
    )

    assert len(calls) == 2
    assert all(len(call) == 1 for call in calls)
    assert [catalog["courses"][0]["page"] for catalog in catalogs] == [5, 6]
    assert [page.number for page in successful] == [5, 6]
    assert failed == []
    assert first_error is None


@pytest.mark.parametrize("reason", ["tls_failed", "protocol_failed"])
def test_transport_failure_opens_circuit_and_marks_zero_success_as_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, reason: str
) -> None:
    attachment = tmp_path / "curriculum.pdf"
    attachment.write_bytes(b"pdf")
    pages = [
        attachment_extract._VisualPage(
            number=page_number,
            image={"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}},
            source_text=f"A20400{page_number} 课程{page_number} 3 {page_number} 必修",
        )
        for page_number in (6, 7, 8)
    ]
    calls = 0

    @contextmanager
    def fake_visual_inputs(_attachment: Path, _max_pdf_pages: int):
        yield pages

    class FakeDashScopeClient:
        def __init__(self, _config: object) -> None:
            pass

        def extract_course_records(self, _source_inputs: list[dict[str, object]]) -> str:
            nonlocal calls
            calls += 1
            raise DashScopeError(
                "MODEL_REQUEST_FAILED",
                "模型请求失败",
                {"reason": reason, "attempts": 2},
            )

    monkeypatch.setattr(attachment_extract, "_visual_inputs", fake_visual_inputs)
    monkeypatch.setattr(attachment_extract, "DashScopeClient", FakeDashScopeClient)
    monkeypatch.setattr(attachment_extract, "NATIVE_TEXT_BATCH_CHARACTERS", 1)

    response = handle_curriculum_extract_from_attachment(
        {
            "attachment_path": str(attachment),
            "major": "computer-science",
            "cohort": "2026",
            "version": "2026.1",
        }
    )

    assert response["ok"] is True
    assert calls == 1
    assert response["data"]["extraction_summary"]["status"] == "EXTRACTION_FAILED"
    assert response["data"]["extraction_summary"]["pages_succeeded"] == []
    assert response["data"]["extraction_summary"]["pages_failed"][1]["circuit_open"] is True
    assert response["data"]["extraction_summary"]["pages_attempted"] == [6]
    assert response["data"]["extraction_summary"]["pages_skipped"] == [7, 8]
    assert response["data"]["course_line_candidates"][0]["verified"] is False
    assert "CURRICULUM_EXTRACTION_FAILED" in response["warnings"]


def test_native_course_line_candidates_keep_literal_page_evidence_only() -> None:
    pages = [
        attachment_extract._VisualPage(
            number=6,
            image={"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}},
            source_text=(
                "课程号 课程名称 学分\n"
                "A1100015 形势与政策 1 32 考查 1,4,5,7\n"
                "毕业要求提到 A2040200，但这不是课程表行。\n"
            ),
        )
    ]

    candidates = attachment_extract._native_course_line_candidates(pages)

    assert candidates == [
        {
            "page": 6,
            "course_code": "A1100015",
            "raw_line": "A1100015 形势与政策 1 32 考查 1,4,5,7",
            "verified": False,
        }
    ]


def test_attachment_cleanup_removes_only_expired_server_workspaces(tmp_path: Path) -> None:
    expired_workspace = tmp_path / "course-path-pdf-expired"
    current_workspace = tmp_path / "course-path-pdf-current"
    unrelated_directory = tmp_path / "unrelated"
    expired_workspace.mkdir()
    current_workspace.mkdir()
    unrelated_directory.mkdir()
    old_timestamp = (datetime.now(timezone.utc) - timedelta(hours=25)).timestamp()
    os.utime(expired_workspace, (old_timestamp, old_timestamp))

    cleanup_stale_temporary_workspaces(temporary_root=tmp_path)

    assert expired_workspace.exists() is False
    assert current_workspace.exists() is True
    assert unrelated_directory.exists() is True


def test_attachment_extraction_prefers_course_table_pages_over_pdf_front_matter() -> None:
    pdf_text = "\f".join(
        [
            "封面和培养目标",
            "毕业要求与学分分配",
            "课程体系流程图 A2041130",
            "课程号 课程名称 学分\nA1100015 形势与政策",
            "课程代码 课程名称 学分\nA2040200 数据结构",
            "课程号 课程名称 学分\nA2040300 计算机网络",
        ]
    )

    selected = _select_course_table_pages(pdf_text, max_pdf_pages=5)

    assert selected == [4, 5, 6]


def _store_curriculum_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> tuple[CurriculumKnowledgeStore, Path, dict[str, object]]:
    attachment = tmp_path / "curriculum.pdf"
    attachment.write_bytes(b"shared-curriculum-document")
    inspection = inspect_attachment(str(attachment))
    assert inspection is not None
    store = CurriculumKnowledgeStore(tmp_path / "curriculum_knowledge_base")
    entry, created = store.store_source(
        attachment_path=str(attachment),
        attachment=inspection,
        major="software-engineering",
        cohort="2026",
        version="2026.1",
    )
    assert created is True
    return store, attachment, entry


def test_curriculum_store_copies_a_shared_plan_without_retaining_its_original_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, attachment, entry = _store_curriculum_source(tmp_path, monkeypatch)

    assert (store.base_dir / entry["stored_file"]).read_bytes() == attachment.read_bytes()
    assert str(attachment) not in str(entry)
    assert entry["knowledge_base"] == "curriculum"
    assert entry["storage_status"] == "SOURCE_STORED"
    assert entry["processing_status"] == "SOURCE_STORED"
    assert entry["extraction_status"] == "EXTRACTION_PENDING"
    assert entry["rag_status"] == "NOT_INDEXED"


def test_curriculum_store_deduplicates_the_same_curriculum_version(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, attachment, first_entry = _store_curriculum_source(tmp_path, monkeypatch)
    inspection = inspect_attachment(str(attachment))
    assert inspection is not None

    repeated_entry, created = store.store_source(
        attachment_path=str(attachment),
        attachment=inspection,
        major="software-engineering",
        cohort="2026",
        version="2026.1",
    )

    assert created is False
    assert repeated_entry["document_id"] == first_entry["document_id"]
    assert len(store.list_documents()) == 1


def test_curriculum_store_lists_documents_by_major_without_exposing_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, attachment, _entry = _store_curriculum_source(tmp_path, monkeypatch)
    inspection = inspect_attachment(str(attachment))
    assert inspection is not None
    store.store_source(
        attachment_path=str(attachment),
        attachment=inspection,
        major="computer-science",
        cohort="2026",
        version="2026.1",
    )

    records = store.list_documents(major="software-engineering")

    assert len(records) == 1
    assert records[0]["major"] == "software-engineering"
    assert "original_path" not in records[0]


def test_curriculum_store_requires_confirmation_before_clearing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, _attachment, _entry = _store_curriculum_source(tmp_path, monkeypatch)

    with pytest.raises(CurriculumStoreError) as error:
        store.clear(confirm=False)

    assert error.value.code == "INVALID_ARGUMENT"
    assert len(store.list_documents()) == 1


def test_curriculum_store_clear_removes_only_its_runtime_records(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, _attachment, _entry = _store_curriculum_source(tmp_path, monkeypatch)
    public_catalog = tmp_path / "course_catalog.json"
    public_catalog.write_text('{"keep": true}', encoding="utf-8")

    removed = store.clear(confirm=True)

    assert removed == 1
    assert store.list_documents() == []
    assert public_catalog.read_text(encoding="utf-8") == '{"keep": true}'


def test_ingestion_stores_the_source_without_starting_remote_processing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import server as course_server

    attachment = tmp_path / "curriculum.png"
    attachment.write_bytes(b"image")
    monkeypatch.setattr(course_server, "curriculum_store", CurriculumKnowledgeStore(tmp_path / "curriculum_knowledge_base"))

    def unexpected_remote_work(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("ingestion must not start extraction or indexing")

    monkeypatch.setattr(course_server, "extract_catalog_from_attachment", unexpected_remote_work)
    monkeypatch.setattr(course_server, "curriculum_search_index", unexpected_remote_work)

    response = handle_curriculum_ingest_from_attachment(
        {
            "attachment_path": str(attachment),
            "major": "software-engineering",
            "cohort": "2026",
            "version": "2026.1",
        }
    )

    assert response["ok"] is True
    assert response["data"]["created"] is True
    assert response["data"]["document"]["storage_status"] == "SOURCE_STORED"
    assert response["data"]["document"]["extraction_status"] == "EXTRACTION_PENDING"
    assert response["data"]["rag_index"] == {
        "indexed": False,
        "status": "NOT_INDEXED",
        "chunk_count": 0,
        "embedding_model": None,
    }
    assert response["data"]["extraction"] == {"status": "EXTRACTION_PENDING"}
    assert {item["tool"] for item in response["data"]["next_actions"]} == {
        "curriculum_index_document",
        "retry_curriculum_extraction",
    }
    assert response["warnings"] == ["CURRICULUM_DOCUMENT_STORED", "PROCESSING_NOT_STARTED"]
    assert response["data"]["catalog_published"] is False


def test_repeated_ingestion_reuses_the_stored_source_without_processing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import server as course_server

    attachment = tmp_path / "curriculum.png"
    attachment.write_bytes(b"image")
    monkeypatch.setattr(course_server, "curriculum_store", CurriculumKnowledgeStore(tmp_path / "curriculum_knowledge_base"))

    payload = {
        "attachment_path": str(attachment),
        "major": "software-engineering",
        "cohort": "2026",
        "version": "2026.1",
    }
    first = handle_curriculum_ingest_from_attachment(payload)
    response = handle_curriculum_ingest_from_attachment(payload)

    assert first["data"]["created"] is True
    assert response["ok"] is True
    assert response["data"]["created"] is False
    assert response["data"]["document"]["document_id"] == first["data"]["document"]["document_id"]


def test_curriculum_index_document_builds_local_evidence_without_remote_embedding(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import server as course_server

    store, _attachment, entry = _store_curriculum_source(tmp_path, monkeypatch)
    monkeypatch.setattr(course_server, "curriculum_store", store)
    monkeypatch.setattr(course_server, "configured_embedding_model", lambda: "text-embedding-v4")
    monkeypatch.setattr(course_server, "configured_semantic_fallback", lambda: False)
    monkeypatch.setattr(
        course_server,
        "extract_document_sources",
        lambda _source, filename: [{"document": filename, "content": "课程证据", "page": 1}],
    )
    def unexpected_index(_base_dir: Path) -> object:
        raise AssertionError("default local indexing must not open Chroma or call embeddings")

    monkeypatch.setattr(course_server, "curriculum_search_index", unexpected_index)

    first = handle_curriculum_index_document({"document_id": entry["document_id"]})
    second = handle_curriculum_index_document({"document_id": entry["document_id"]})

    assert first["ok"] is True
    assert first["data"]["rag_index"] == {
        "indexed": True,
        "index_mode": "lexical",
        "chunk_count": 1,
        "skipped": False,
        "semantic_indexed": False,
    }
    assert first["data"]["document"]["extraction_status"] == "EXTRACTION_PENDING"
    assert second["ok"] is True
    assert second["data"]["rag_index"] == {
        "indexed": True,
        "index_mode": "lexical",
        "chunk_count": 1,
        "skipped": True,
        "semantic_indexed": False,
    }
    assert store.load_evidence(entry["document_id"]) == [
        {
            "document": "curriculum.pdf",
            "section": None,
            "page": 1,
            "content": "课程证据",
            "chunk_index": 0,
        }
    ]


def test_curriculum_index_document_can_opt_in_to_semantic_index(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import server as course_server

    store, _attachment, entry = _store_curriculum_source(tmp_path, monkeypatch)
    monkeypatch.setattr(course_server, "curriculum_store", store)
    monkeypatch.setattr(course_server, "configured_embedding_model", lambda: "text-embedding-v4")
    monkeypatch.setattr(course_server, "configured_semantic_fallback", lambda: True)
    monkeypatch.setattr(
        course_server,
        "extract_document_sources",
        lambda _source, filename: [{"document": filename, "content": "课程证据", "page": 1}],
    )
    calls: list[str] = []

    class IndexStub:
        def index_sources(self, document: dict[str, object], _sources: list[dict[str, object]]) -> int:
            calls.append(str(document["document_id"]))
            return 2

    monkeypatch.setattr(course_server, "curriculum_search_index", lambda _base_dir: IndexStub())

    first = handle_curriculum_index_document({"document_id": entry["document_id"]})
    second = handle_curriculum_index_document({"document_id": entry["document_id"]})

    assert first["ok"] is True
    assert first["data"]["rag_index"] == {"indexed": True, "chunk_count": 2, "skipped": False}
    assert second["ok"] is True
    assert second["data"]["rag_index"] == {
        "indexed": True,
        "chunk_count": 2,
        "skipped": True,
        "reason": "DOCUMENT_ALREADY_INDEXED",
    }
    assert calls == [entry["document_id"]]


def test_curriculum_search_requires_explicit_local_index_and_never_parses_pdf_lazily(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import server as course_server

    store, _attachment, entry = _store_curriculum_source(tmp_path, monkeypatch)
    monkeypatch.setattr(course_server, "curriculum_store", store)
    monkeypatch.setattr(course_server, "configured_semantic_fallback", lambda: False)

    def unexpected_extraction(_source: Path, _filename: str) -> list[dict[str, object]]:
        raise AssertionError("curriculum_search must not parse a PDF or build an index")

    monkeypatch.setattr(course_server, "extract_document_sources", unexpected_extraction)

    response = course_server.handle_curriculum_search(
        {
            "query": "毕业学分要求",
            "document_id": entry["document_id"],
            "top_k": 5,
        }
    )

    assert response["ok"] is False
    assert response["error"] == {
        "code": "EVIDENCE_NOT_INDEXED",
        "message": "培养方案尚未建立本地证据索引",
        "details": {
            "document_ids": [entry["document_id"]],
            "next_tool": "curriculum_index_document",
        },
    }


def test_retry_uses_only_the_managed_source_and_keeps_catalog_unpublished(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import server as course_server

    store, attachment, entry = _store_curriculum_source(tmp_path, monkeypatch)
    monkeypatch.setattr(course_server, "curriculum_store", store)
    observed_paths: list[Path] = []

    def extract_stored(
        input_data: object,
        source: Path,
        inspection: dict[str, object],
    ) -> dict[str, object]:
        observed_paths.append(source)
        assert source != attachment
        assert inspection["status"] == "VALID"
        return {
            "catalog": {
                "catalog_id": "software-engineering-2026-2026-1",
                "data_status": "draft",
                "document": "curriculum.pdf",
                "major": "software-engineering",
                "cohort": "2026",
                "version": "2026.1",
                "courses": [],
            },
            "validation": {"valid": False, "course_count": 0, "errors": [], "warnings": []},
            "review": {
                "review_status": "REVIEW_FAILED",
                "auto_verified": False,
                "catalog": {},
                "validation": {},
                "review": {},
                "warnings": [],
            },
        }

    monkeypatch.setattr(course_server, "extract_catalog_from_stored_attachment", extract_stored)

    response = handle_retry_curriculum_extraction(entry["document_id"])

    assert response["ok"] is True
    assert observed_paths == [store.base_dir / entry["stored_file"]]
    assert response["data"]["document"]["processing_status"] == "REVIEW_FAILED"
    assert response["data"]["catalog_published"] is False
    assert str(store.base_dir) not in str(response)


def test_retry_rejects_an_unknown_document_id(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import server as course_server

    monkeypatch.setattr(course_server, "curriculum_store", CurriculumKnowledgeStore(tmp_path / "curriculum_knowledge_base"))

    response = handle_retry_curriculum_extraction("curriculum-missing")

    assert response["ok"] is False
    assert response["error"]["code"] == "DOCUMENT_NOT_FOUND"


def test_retry_recommends_connectivity_check_before_another_full_extraction(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import server as course_server

    store, _attachment, entry = _store_curriculum_source(tmp_path, monkeypatch)
    monkeypatch.setattr(course_server, "curriculum_store", store)
    monkeypatch.setattr(
        course_server,
        "extract_catalog_from_stored_attachment",
        lambda *_args: {
            "catalog": None,
            "validation": {"valid": False, "course_count": 0, "errors": [], "warnings": []},
            "review": {"review_status": "MODEL_REVIEW_REQUIRED", "auto_verified": False, "catalog": None},
            "extraction_summary": {
                "status": "EXTRACTION_FAILED",
                "pages_total": 1,
                "pages_attempted": [6],
                "pages_skipped": [],
                "pages_succeeded": [],
                "pages_failed": [{"page": 6, "code": "MODEL_REQUEST_FAILED", "reason": "connection_failed"}],
            },
            "sources": [],
        },
    )

    response = handle_retry_curriculum_extraction(entry["document_id"])

    assert response["ok"] is True
    assert response["data"]["next_actions"][0]["tool"] == "curriculum_model_check"
    assert response["data"]["catalog_published"] is False


def test_list_and_clear_handlers_use_the_curriculum_partition_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import server as course_server

    store, _attachment, _entry = _store_curriculum_source(tmp_path, monkeypatch)
    monkeypatch.setattr(course_server, "curriculum_store", store)

    listing = handle_list_curriculum_documents({"major": "software-engineering"})
    clear_response = handle_clear_curriculum_knowledge_base({"confirm": True})

    assert listing["ok"] is True
    assert listing["data"]["total"] == 1
    assert clear_response["ok"] is True
    assert clear_response["data"]["removed_documents"] == 1
    assert clear_response["data"]["course_catalog_modified"] is False


def test_configured_directory_uses_default_when_storage_override_is_unset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("CURRICULUM_KNOWLEDGE_BASE_DIR", raising=False)

    resolved = configured_directory("CURRICULUM_KNOWLEDGE_BASE_DIR", tmp_path / "default")

    assert resolved == tmp_path / "default"


def test_configured_directory_accepts_an_absolute_local_storage_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    configured_path = tmp_path / "shared-curriculum"
    monkeypatch.setenv("CURRICULUM_KNOWLEDGE_BASE_DIR", str(configured_path))

    resolved = configured_directory("CURRICULUM_KNOWLEDGE_BASE_DIR", tmp_path / "default")

    assert resolved == configured_path.resolve()


def test_model_config_uses_local_model_overrides_without_changing_the_file(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("COURSE_PATH_OCR_MODEL", "qwen3.8-flash")
    monkeypatch.setenv("COURSE_PATH_REVIEW_MODEL", "qwen3.8-max")

    config = DashScopeConfig.from_file(PROJECT_ROOT / "data" / "model_config.json")

    assert config.ocr_model == "qwen3.8-flash"
    assert config.review_model == "qwen3.8-max"


def test_visual_extraction_requests_a_json_course_array(monkeypatch: pytest.MonkeyPatch) -> None:
    client = DashScopeClient(
        DashScopeConfig(
            chat_completions_url="https://example.invalid/v1/chat/completions",
            ocr_model="qwen3.8-flash",
            review_model="qwen3.8-flash",
            request_timeout_seconds=60,
            max_pdf_pages=5,
        )
    )
    captured: dict[str, object] = {}

    def fake_request(
        model: str,
        content: list[dict[str, object]],
        *,
        response_format: dict[str, str] | None = None,
    ) -> dict[str, object]:
        captured["model"] = model
        captured["content"] = content
        captured["response_format"] = response_format
        return {"choices": [{"message": {"content": '{"courses": []}'}}]}

    monkeypatch.setattr(client, "_request", fake_request)

    assert client.extract_course_records([]) == '{"courses": []}'
    assert captured["model"] == "qwen3.8-flash"
    assert captured["response_format"] == {"type": "json_object"}


def test_flow_extraction_uses_course_reference_and_compatible_multimodal_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-only-key")
    captured: dict[str, object] = {}
    client = DashScopeClient(
        DashScopeConfig(
            chat_completions_url="https://example.invalid/v1/chat/completions",
            ocr_model="qwen3.8-flash",
            review_model="qwen3.8-flash",
            request_timeout_seconds=60,
            max_pdf_pages=5,
        )
    )

    def fake_request_once(
        _api_key: str,
        body: dict[str, object],
        *,
        timeout_seconds: int | None = None,
    ) -> dict[str, object]:
        captured["body"] = body
        captured["timeout"] = timeout_seconds
        return {"choices": [{"message": {"content": '{"edges": []}'}}]}

    monkeypatch.setattr(client, "_request_once", fake_request_once)
    result = client.extract_recommended_sequences(
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AA=="}},
        [{"id": "A2040190", "name": "C语言程序设计", "suggestedSemester": 1}],
    )

    assert result == {"edges": []}
    body = captured["body"]
    assert isinstance(body, dict)
    assert "response_format" not in body
    assert captured["timeout"] == 35
    messages = body["messages"]
    assert isinstance(messages, list)
    prompt = messages[0]["content"][0]["text"]
    assert '"id":"A2040190"' in prompt
    assert '"name":"C语言程序设计"' in prompt


def test_model_transport_uses_dashscope_openai_compatibility_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-only-key")
    observed: dict[str, object] = {}

    class FakeCompletions:
        def create(self, **kwargs: object) -> object:
            observed.update(kwargs)
            return iter(
                [
                    SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content='{"courses": '), finish_reason=None)]),
                    SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content="[]}"), finish_reason="stop")]),
                    SimpleNamespace(choices=[]),
                ]
            )

    class FakeClient:
        chat = type("FakeChat", (), {"completions": FakeCompletions()})()

    def client_factory(api_key: str) -> object:
        observed["api_key"] = api_key
        return FakeClient()

    client = DashScopeClient(
        DashScopeConfig(
            chat_completions_url="https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
            ocr_model="qwen3.8-flash",
            review_model="qwen3.8-flash",
            request_timeout_seconds=60,
            max_pdf_pages=5,
        ),
        client_factory=client_factory,
    )

    response = client._request(
        "qwen3.8-flash",
        [{"type": "text", "text": "source"}],
        response_format={"type": "json_object"},
    )

    assert response["choices"][0]["message"]["content"] == '{"courses": []}'
    assert observed["api_key"] == "test-only-key"
    assert observed["model"] == "qwen3.8-flash"
    assert observed["response_format"] == {"type": "json_object"}
    assert observed["extra_body"] == {"enable_thinking": False}
    assert observed["stream"] is True


def test_streamed_extraction_rejects_partial_json_after_protocol_disconnect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-only-key")

    class FakeCompletions:
        def create(self, **_kwargs: object) -> object:
            def chunks():
                yield SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content='{"courses": ['), finish_reason=None)])
                raise httpx.RemoteProtocolError("server disconnected")

            return chunks()

    class FakeClient:
        chat = type("FakeChat", (), {"completions": FakeCompletions()})()

    client = DashScopeClient(
        DashScopeConfig(
            chat_completions_url="https://example.invalid/v1/chat/completions",
            ocr_model="qwen3.8-flash",
            review_model="qwen3.8-flash",
            request_timeout_seconds=45,
            max_pdf_pages=5,
        ),
        client_factory=lambda _key: FakeClient(),
    )

    with pytest.raises(DashScopeError) as failure:
        client.extract_course_records([{"type": "text", "text": "page 6 source"}])

    assert failure.value.details == {"reason": "protocol_failed", "attempts": 1}


def test_streamed_extraction_rejects_output_cut_off_by_model_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-only-key")

    class FakeCompletions:
        def create(self, **_kwargs: object) -> object:
            return iter(
                [
                    SimpleNamespace(
                        choices=[SimpleNamespace(delta=SimpleNamespace(content='{"courses": []}'), finish_reason="length")]
                    )
                ]
            )

    class FakeClient:
        chat = SimpleNamespace(completions=FakeCompletions())

    client = DashScopeClient(
        DashScopeConfig(
            chat_completions_url="https://example.invalid/v1/chat/completions",
            ocr_model="qwen3.8-flash",
            review_model="qwen3.8-flash",
            request_timeout_seconds=45,
            max_pdf_pages=5,
        ),
        client_factory=lambda _key: FakeClient(),
    )

    with pytest.raises(DashScopeError) as failure:
        client.extract_course_records([{"type": "text", "text": "page 6 source"}])

    assert failure.value.code == "MODEL_RESPONSE_INVALID"
    assert failure.value.details == {"reason": "incomplete_stream", "attempts": 1}


def test_model_check_sends_only_a_small_request_without_document_content(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-only-key")
    observed: dict[str, object] = {}
    client = DashScopeClient(
        DashScopeConfig(
            chat_completions_url="https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
            ocr_model="qwen3.8-flash",
            review_model="qwen3.8-flash",
            request_timeout_seconds=45,
            max_pdf_pages=5,
        )
    )

    def fake_request_once(_key: str, body: dict[str, object], *, timeout_seconds: int) -> dict[str, object]:
        observed.update(body)
        observed["timeout_seconds"] = timeout_seconds
        return {"choices": [{"message": {"content": "OK"}}]}

    monkeypatch.setattr(client, "_request_once", fake_request_once)
    client.check_connection()

    assert observed["model"] == "qwen3.8-flash"
    assert observed["max_tokens"] == 8
    assert observed["timeout_seconds"] == 8
    assert "PDF" not in str(observed["messages"])


def test_model_check_returns_safe_failure_without_starting_pdf_extraction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import server as course_server

    class FailedClient:
        def __init__(self, _config: object) -> None:
            pass

        def check_connection(self) -> None:
            raise DashScopeError("MODEL_REQUEST_FAILED", "模型请求失败", {"reason": "proxy_failed"})

    monkeypatch.setattr(course_server, "DashScopeClient", FailedClient)

    response = handle_curriculum_model_check()

    assert response["ok"] is False
    assert response["error"]["details"] == {"reason": "proxy_failed"}
    assert response["meta"]["tool"] == "curriculum_model_check"


def test_model_check_reports_success_without_echoing_provider_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import server as course_server

    class WorkingClient:
        def __init__(self, _config: object) -> None:
            pass

        def check_connection(self) -> None:
            return None

    monkeypatch.setattr(course_server, "DashScopeClient", WorkingClient)

    response = handle_curriculum_model_check()

    assert response["ok"] is True
    assert response["data"] == {"reachable": True, "model": "qwen3.8-flash"}
    assert response["meta"]["tool"] == "curriculum_model_check"


def test_extraction_probe_compares_modes_without_returning_page_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import server as course_server

    page_text = "private page content for transport test"
    seen_modes: list[bool] = []
    monkeypatch.setattr(
        course_server,
        "curriculum_store",
        SimpleNamespace(load_source_for_retry=lambda _id: ({"document_id": "doc-1"}, Path("stored.pdf"), {})),
    )
    monkeypatch.setattr(course_server, "native_page_text_for_probe", lambda _source, _page: page_text)

    class ProbeClient:
        def __init__(self, _config: object) -> None:
            pass

        def probe_extraction_transport(self, text: str, *, stream: bool) -> None:
            assert text == page_text
            seen_modes.append(stream)
            if stream:
                raise DashScopeError("MODEL_REQUEST_FAILED", "模型请求失败", {"reason": "tls_failed"})

    monkeypatch.setattr(course_server, "DashScopeClient", ProbeClient)

    result = course_server.handle_curriculum_extraction_probe("doc-1", 6)

    assert result["ok"] is True
    assert seen_modes == [False, True]
    assert result["data"]["modes"]["non_stream"]["reachable"] is True
    assert result["data"]["modes"]["stream"]["reason"] == "tls_failed"
    assert page_text not in json.dumps(result, ensure_ascii=False)


def test_extraction_probe_rejects_invalid_page_before_reading_store(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import server as course_server

    monkeypatch.setattr(course_server, "curriculum_store", SimpleNamespace(load_source_for_retry=lambda _id: pytest.fail("store read")))

    result = course_server.handle_curriculum_extraction_probe("doc-1", 0)

    assert result["error"]["code"] == "INVALID_ARGUMENT"
    assert result["error"]["details"]["reason"] == "page_out_of_range"


def test_extraction_probe_sends_one_page_with_bounded_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-only-key")
    client = DashScopeClient(DashScopeConfig(
        chat_completions_url="https://example.invalid/v1/chat/completions",
        ocr_model="qwen3.8-flash",
        review_model="qwen3.8-flash",
        request_timeout_seconds=45,
        max_pdf_pages=5,
    ))
    observed: list[dict[str, object]] = []

    def fake_request_once(_key: str, body: dict[str, object], *, timeout_seconds: int) -> dict[str, object]:
        observed.append({**body, "timeout_seconds": timeout_seconds})
        return {"choices": [{"message": {"content": '{"ok": true}'}}]}

    monkeypatch.setattr(client, "_request_once", fake_request_once)
    client.probe_extraction_transport("page six text", stream=False)
    client.probe_extraction_transport("page six text", stream=True)

    assert [request["stream"] for request in observed] == [False, True]
    assert all(request["max_tokens"] == 64 for request in observed)
    assert all(request["timeout_seconds"] == 30 for request in observed)
    assert "page six text" in str(observed[0]["messages"])


def test_extraction_probe_requires_native_page_text(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(attachment_extract, "_extract_pdf_pages", lambda _source: ["first page", ""])

    with pytest.raises(AttachmentExtractError) as failure:
        attachment_extract.native_page_text_for_probe(Path("stored.pdf"), 2)

    assert failure.value.code == "PAGE_TEXT_UNAVAILABLE"


@pytest.mark.parametrize(
    ("error", "reason"),
    [
        (TimeoutError(), "timeout"),
        (socket.gaierror(socket.EAI_NONAME, "host unavailable"), "dns_resolution_failed"),
        (ssl.SSLError("handshake failed"), "tls_failed"),
        (ConnectionRefusedError(), "connection_refused"),
        (httpx.ProxyError("proxy unavailable"), "proxy_failed"),
        (httpx.ConnectTimeout("slow connection"), "timeout"),
        (httpx.RemoteProtocolError("closed"), "protocol_failed"),
        (OSError(), "connection_failed"),
    ],
)
def test_model_transport_failures_have_safe_diagnostic_reasons(error: object, reason: str) -> None:
    assert _network_error_reason(error) == reason


def test_model_transport_classification_walks_nested_causes_without_returning_raw_errors() -> None:
    wrapped = RuntimeError("outer error with private URL")
    wrapped.__cause__ = httpx.ProxyError("proxy hostname must stay private")

    assert _network_error_reason(wrapped) == "proxy_failed"


def test_model_request_retries_temporary_transport_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-only-key")
    delays: list[float] = []
    attempts = 0
    client = DashScopeClient(
        DashScopeConfig(
            chat_completions_url="https://example.invalid/v1/chat/completions",
            ocr_model="qwen3.8-flash",
            review_model="qwen3.8-flash",
            request_timeout_seconds=60,
            max_pdf_pages=5,
        )
    )

    def fake_request_once(_api_key: str, _body: dict[str, object]) -> dict[str, object]:
        nonlocal attempts
        attempts += 1
        if attempts < 2:
            raise DashScopeError("MODEL_REQUEST_FAILED", "模型请求失败", {"reason": "timeout"})
        return {"choices": [{"message": {"content": '{"courses": []}'}}]}

    monkeypatch.setattr(client, "_request_once", fake_request_once)
    monkeypatch.setattr(dashscope_client.time, "sleep", delays.append)

    response = client._request("qwen3.8-flash", [])

    assert response["choices"][0]["message"]["content"] == '{"courses": []}'
    assert attempts == 2
    assert delays == [1.0]


def test_model_request_does_not_retry_connection_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-only-key")
    client = DashScopeClient(
        DashScopeConfig(
            chat_completions_url="https://example.invalid/v1/chat/completions",
            ocr_model="qwen3.8-flash",
            review_model="qwen3.8-flash",
            request_timeout_seconds=45,
            max_pdf_pages=5,
        )
    )
    calls = 0

    def failed_request(_key: str, _body: dict[str, object]) -> dict[str, object]:
        nonlocal calls
        calls += 1
        raise DashScopeError("MODEL_REQUEST_FAILED", "模型请求失败", {"reason": "connection_failed"})

    monkeypatch.setattr(client, "_request_once", failed_request)

    with pytest.raises(DashScopeError) as failure:
        client._request("qwen3.8-flash", [])

    assert calls == 1
    assert failure.value.details == {"reason": "connection_failed", "attempts": 1}


def test_curriculum_store_persists_partial_evidence_chunks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, _attachment, entry = _store_curriculum_source(tmp_path, monkeypatch)
    result = {
        "catalog": None,
        "validation": {"valid": False, "course_count": 0, "errors": [], "warnings": []},
        "review": {
            "review_status": "MODEL_REVIEW_REQUIRED",
            "auto_verified": False,
            "catalog": None,
            "validation": {},
            "review": None,
            "warnings": [],
        },
        "extraction_summary": {
            "status": "EXTRACTION_PARTIAL",
            "pages_total": 2,
            "pages_attempted": [5, 6],
            "pages_succeeded": [5],
            "pages_failed": [{"page": 6, "code": "MODEL_REQUEST_FAILED"}],
            "retryable": True,
        },
        "sources": [
            {
                "document": "curriculum.pdf",
                "section": None,
                "page": 5,
                "content": "课程号 课程名称 学分",
                "chunk_index": 0,
                "score": None,
            }
        ],
    }

    updated = store.save_extraction_result(entry["document_id"], result)
    stored_result = json.loads((store.base_dir / updated["extraction_file"]).read_text(encoding="utf-8"))

    assert updated["processing_status"] == "EXTRACTION_PARTIAL"
    assert updated["catalog_file"] is None
    assert stored_result["sources"][0]["page"] == 5
    assert stored_result["sources"][0]["content"] == "课程号 课程名称 学分"

    import server as course_server

    monkeypatch.setattr(course_server, "curriculum_store", store)
    response = handle_get_curriculum_document(entry["document_id"])

    assert response["ok"] is True
    assert response["data"]["extraction"]["summary"]["status"] == "EXTRACTION_PARTIAL"
    assert response["sources"][0]["page"] == 5
    assert "CURRICULUM_EXTRACTION_PARTIAL" in response["warnings"]


def test_curriculum_store_records_zero_course_extraction_as_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, _attachment, entry = _store_curriculum_source(tmp_path, monkeypatch)
    result = {
        "catalog": None,
        "validation": {"valid": False, "course_count": 0, "errors": [], "warnings": []},
        "review": {
            "review_status": "MODEL_REVIEW_REQUIRED",
            "auto_verified": False,
            "catalog": None,
            "validation": {},
            "review": None,
            "warnings": [],
        },
        "extraction_summary": {
            "status": "EXTRACTION_FAILED",
            "pages_total": 2,
            "pages_attempted": [6, 7],
            "pages_succeeded": [],
            "pages_failed": [{"page": 6, "code": "MODEL_REQUEST_FAILED"}],
            "retryable": True,
        },
        "sources": [],
    }

    updated = store.save_extraction_result(entry["document_id"], result)

    assert updated["processing_status"] == "EXTRACTION_FAILED"
    assert updated["extraction_status"] == "EXTRACTION_FAILED"


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
                assert {tool.name for tool in tools.tools} == {
                    "course_path_plan",
                    "catalog_validate",
                    "curriculum_extract",
                    "catalog_review",
                    "curriculum_extract_from_attachment",
                    "parse_program_plan",
                    "curriculum_ingest_from_attachment",
                    "curriculum_index_document",
                    "retry_curriculum_extraction",
                    "curriculum_model_check",
                    "curriculum_extraction_probe",
                    "list_curriculum_documents",
                    "get_curriculum_document",
                    "curriculum_graph",
                    "save_course_progress",
                    "load_course_progress",
                    "clear_course_progress",
                    "curriculum_search",
                    "clear_curriculum_knowledge_base",
                }

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

                missing_plan = await session.call_tool(
                    "parse_program_plan",
                    arguments={"filePath": "Z:/missing-curriculum.pdf"},
                )
                assert missing_plan.isError is False
                assert missing_plan.structuredContent == {
                    "success": False,
                    "errorCode": "FILE_CORRUPTED",
                    "errorMessage": "文件损坏或无法读取，请重新上传",
                }

                validation_result = await session.call_tool(
                    "catalog_validate",
                    arguments={"catalog": load_catalog()},
                )
                assert validation_result.isError is False
                assert validation_result.structuredContent is not None
                assert validation_result.structuredContent["data"]["valid"] is True

                extraction_result = await session.call_tool(
                    "curriculum_extract",
                    arguments=_extract_payload(),
                )
                assert extraction_result.isError is False
                assert extraction_result.structuredContent is not None
                assert extraction_result.structuredContent["data"]["validation"]["valid"] is True

                review_result = await session.call_tool(
                    "catalog_review",
                    arguments={"catalog": load_catalog(), "model_review": _model_review()},
                )
                assert review_result.isError is False
                assert review_result.structuredContent is not None
                assert review_result.structuredContent["data"]["auto_verified"] is True

    anyio.run(call_tool)


def test_curriculum_search_returns_portable_evidence_over_stdio(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, _attachment, entry = _store_curriculum_source(tmp_path, monkeypatch)
    store.save_evidence(
        str(entry["document_id"]),
        [
            {
                "document": "curriculum.pdf",
                "section": None,
                "page": 6,
                "content": "毕业学分要求包括专业课程和实践课程学分。",
                "chunk_index": 0,
            }
        ],
    )

    async def call_tool() -> None:
        parameters = StdioServerParameters(
            command=sys.executable,
            args=["server.py"],
            cwd=PROJECT_ROOT,
            env={
                "CURRICULUM_KNOWLEDGE_BASE_DIR": str(store.base_dir),
                "CURRICULUM_SEMANTIC_FALLBACK": "false",
            },
        )
        async with stdio_client(parameters) as (read_stream, write_stream):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                result = await session.call_tool(
                    "curriculum_search",
                    arguments={
                        "query": "毕业学分要求和课程类别",
                        "document_id": entry["document_id"],
                        "top_k": 5,
                    },
                )
                assert result.isError is False
                assert result.structuredContent is not None
                assert result.structuredContent["meta"]["tool"] == "curriculum_search"
                assert result.structuredContent["data"]["search_mode"] == "lexical"
                assert result.structuredContent["data"]["match_count"] == 1
                assert result.structuredContent["sources"][0]["page"] == 6

    anyio.run(call_tool)


def test_catalog_validation_accepts_the_current_mock_catalog() -> None:
    result = validate_catalog(load_catalog())

    assert result["valid"] is True
    assert result["course_count"] == 7
    assert result["errors"] == []
    assert "CATALOG_NOT_VERIFIED:mock" in result["warnings"]


def test_catalog_validation_rejects_duplicate_course_codes() -> None:
    catalog = deepcopy(load_catalog())
    catalog["courses"].append(deepcopy(catalog["courses"][0]))

    result = validate_catalog(catalog)

    assert result["valid"] is False
    assert any(error["code"] == "COURSE_CODE_DUPLICATE" for error in result["errors"])


def test_catalog_validation_rejects_unknown_prerequisites() -> None:
    catalog = deepcopy(load_catalog())
    catalog["courses"][0]["prerequisites"] = ["MISSING"]

    result = validate_catalog(catalog)

    assert result["valid"] is False
    assert any(error["code"] == "PREREQUISITE_NOT_FOUND" for error in result["errors"])


def test_catalog_validation_rejects_prerequisite_cycles() -> None:
    catalog = deepcopy(load_catalog())
    catalog["courses"][0]["prerequisites"] = ["SE201"]

    result = validate_catalog(catalog)

    assert result["valid"] is False
    assert any(error["code"] == "PREREQUISITE_CYCLE" for error in result["errors"])


def test_catalog_validation_returns_the_shared_response_envelope() -> None:
    response = handle_catalog_validate(load_catalog())

    assert response["ok"] is True
    assert response["data"]["valid"] is True
    assert response["meta"]["tool"] == "catalog_validate"


def _extract_payload() -> dict[str, object]:
    return {
        "document": "演示培养方案.pdf",
        "major": "software-engineering",
        "cohort": "2026",
        "version": "2026.1",
        "course_table_tsv": (
            "course_code\tcourse_name\tcredits\tsemester\tcategory\tprerequisites\tpage\tsection\n"
            "SE101\t程序设计基础\t3\t1\t专业基础课\t\t1\t课程设置\n"
            "SE201\t数据结构\t4\t2\t专业核心课\tSE101\t2\t课程设置"
        ),
    }


def test_curriculum_extract_creates_a_valid_draft_catalog() -> None:
    catalog = extract_catalog_draft(CurriculumExtractInput.from_payload(_extract_payload()))

    assert catalog["catalog_id"] == "software-engineering-2026-2026-1"
    assert catalog["data_status"] == "draft"
    assert catalog["courses"][1]["prerequisites"] == ["SE101"]
    assert validate_catalog(catalog)["valid"] is True


def test_curriculum_extract_normalizes_common_chinese_tsv_headers() -> None:
    payload = _extract_payload()
    payload["course_table_tsv"] = (
        "课程代码\t课程名称\t学分\t建议学期\t课程类别\t先修课程\t页码\t章节\n"
        "SE101\t程序设计基础\t3\t1\t专业基础课\t\t1\t课程设置"
    )

    catalog = extract_catalog_draft(CurriculumExtractInput.from_payload(payload))

    assert catalog["courses"] == [
        {
            "course_code": "SE101",
            "course_name": "程序设计基础",
            "credits": 3,
            "semester": 1,
            "category": "专业基础课",
            "prerequisites": [],
            "page": 1,
            "section": "课程设置",
        }
    ]


def test_curriculum_extract_normalizes_a_markdown_table_with_preamble() -> None:
    payload = _extract_payload()
    payload["course_table_tsv"] = (
        "以下是课程表：\n"
        "| 课程代码 | 课程名称 | 学分 | 学期 | 类别 | 先修课程 | 页码 | 章节 |\n"
        "| --- | --- | --- | --- | --- | --- | --- | --- |\n"
        "| SE101 | 程序设计基础 | 3 | 1 | 专业基础课 |  | 1 | 课程设置 |"
    )

    catalog = extract_catalog_draft(CurriculumExtractInput.from_payload(payload))

    assert catalog["courses"][0]["course_code"] == "SE101"
    assert catalog["courses"][0]["prerequisites"] == []


def test_curriculum_extract_normalizes_a_json_course_array() -> None:
    payload = _extract_payload()
    payload["course_table_tsv"] = json.dumps(
        {
            "courses": [
                {
                    "课程号": "SE101",
                    "课程名称": "程序设计基础",
                    "学分": 3,
                    "开课学期": 1,
                    "修读要求": "必修",
                    "先修课程": [],
                    "页码": 6,
                    "章节": "课程设置",
                }
            ]
        },
        ensure_ascii=False,
    )

    catalog = extract_catalog_draft(CurriculumExtractInput.from_payload(payload))

    assert catalog["courses"][0]["semester"] == 1
    assert catalog["courses"][0]["category"] == "必修"


def test_curriculum_extract_rejects_missing_table_columns() -> None:
    payload = _extract_payload()
    payload["course_table_tsv"] = "course_code\tcourse_name\nSE101\t程序设计基础"

    with pytest.raises(CurriculumExtractError) as error:
        extract_catalog_draft(CurriculumExtractInput.from_payload(payload))

    assert error.value.code == "INVALID_ARGUMENT"
    assert error.value.details["reason"] == "required_columns_missing"


def test_curriculum_extract_returns_a_shared_error_for_invalid_table_text() -> None:
    payload = _extract_payload()
    payload["course_table_tsv"] = "course_code\tcourse_name\nSE101\t程序设计基础"

    response = handle_curriculum_extract(payload)

    assert response["ok"] is False
    assert response["error"]["code"] == "INVALID_ARGUMENT"
    assert response["meta"]["tool"] == "curriculum_extract"


def _model_review() -> dict[str, object]:
    return {"model": "reviewer-test", "overall_confidence": 0.95, "findings": []}


def test_catalog_review_auto_verifies_a_clean_high_confidence_catalog() -> None:
    result = review_catalog(CatalogReviewInput(catalog=load_catalog(), model_review=_model_review()))

    assert result["auto_verified"] is True
    assert result["review_status"] == "AUTO_VERIFIED"
    assert result["catalog"]["data_status"] == "auto_verified"
    assert "CATALOG_AUTO_VERIFIED_NOT_OFFICIAL" in result["warnings"]


def test_catalog_review_refuses_auto_verification_for_low_confidence() -> None:
    model_review = _model_review()
    model_review["overall_confidence"] = 0.89

    result = review_catalog(CatalogReviewInput(catalog=load_catalog(), model_review=model_review))

    assert result["auto_verified"] is False
    assert result["review_status"] == "REVIEW_FAILED"
    assert "MODEL_REVIEW_CONFIDENCE_LOW" in result["warnings"]


def test_catalog_review_refuses_auto_verification_for_blocking_finding() -> None:
    model_review = _model_review()
    model_review["findings"] = [
        {
            "code": "PREREQUISITE_UNCLEAR",
            "message": "原文未确认 SE401 的先修关系",
            "severity": "blocking",
            "course_code": "SE401",
            "field": "prerequisites",
            "evidence": {"page": 4, "content": "先修关系待确认"},
        }
    ]

    result = review_catalog(CatalogReviewInput(catalog=load_catalog(), model_review=model_review))

    assert result["auto_verified"] is False
    assert "MODEL_REVIEW_BLOCKING_FINDINGS" in result["warnings"]


def test_catalog_review_requires_a_structured_model_report() -> None:
    with pytest.raises(CatalogReviewError) as error:
        review_catalog(
            CatalogReviewInput(
                catalog=load_catalog(),
                model_review={"model": "reviewer-test", "overall_confidence": 0.95, "findings": "none"},
            )
        )

    assert error.value.details["reason"] == "findings_must_be_list"


def test_catalog_review_returns_model_required_without_a_model_result() -> None:
    result = review_catalog(CatalogReviewInput(catalog=load_catalog()))

    assert result["auto_verified"] is False
    assert result["review_status"] == "MODEL_REVIEW_REQUIRED"


def test_catalog_review_returns_a_shared_error_for_invalid_model_review() -> None:
    response = handle_catalog_review(
        {"catalog": load_catalog(), "model_review": {"model": "reviewer-test", "overall_confidence": 1.2, "findings": []}}
    )

    assert response["ok"] is False
    assert response["error"]["code"] == "INVALID_ARGUMENT"
    assert response["meta"]["tool"] == "catalog_review"
