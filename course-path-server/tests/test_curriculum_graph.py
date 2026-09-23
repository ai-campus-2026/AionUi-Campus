"""The UI graph must never use an incomplete or unreviewed course catalog."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

import server
from tools.curriculum_store import AnonymousProgressStore

PROFILE_ID = "123e4567-e89b-42d3-a456-426614174000"


def _catalog() -> dict[str, object]:
    return {
        "catalog_id": "cs-2026-v1",
        "data_status": "auto_verified",
        "document": "计算机科学与技术培养方案.pdf",
        "major": "computer-science",
        "cohort": "2026",
        "version": "2026.1",
        "courses": [
            {
                "course_code": "CS101", "course_name": "程序设计", "credits": 3,
                "semester": 1, "category": "专业基础课", "prerequisites": [],
                "page": 6, "section": "指导性教学计划",
            },
            {
                "course_code": "CS201", "course_name": "数据结构", "credits": 4,
                "semester": 2, "category": "专业核心课", "prerequisites": ["CS101"],
                "page": 7, "section": "指导性教学计划",
            },
        ],
    }


def _store(monkeypatch: pytest.MonkeyPatch, catalog: dict[str, object] | None, *, verified: bool) -> None:
    document = {
        "document_id": "curriculum-cs-2026",
        "processing_status": "AUTO_VERIFIED" if verified else "EXTRACTION_FAILED",
        "auto_verified": verified,
    }
    extraction = None if catalog is None else {
        "catalog": catalog,
        "extraction_summary": {"status": "EXTRACTION_COMPLETE" if verified else "EXTRACTION_FAILED"},
        "review": {"auto_verified": verified},
    }
    monkeypatch.setattr(server, "curriculum_store", SimpleNamespace(load_extraction_result=lambda _id: (document, extraction)))


def _preview_store(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    source = tmp_path / "curriculum.pdf"
    source.write_bytes(b"%PDF-1.7 test")
    document = {
        "document_id": "curriculum-cs-2026",
        "processing_status": "EXTRACTION_FAILED",
        "auto_verified": False,
        "cohort": "2026",
        "version": "2026.1",
    }
    monkeypatch.setattr(server, "curriculum_store", SimpleNamespace(
        load_extraction_result=lambda _id: (document, None),
        load_source_for_retry=lambda _id: (document, source, {"status": "VALID"}),
    ))
    monkeypatch.setattr(server, "native_pdf_pages_for_plan", lambda _source: [
        "计算机科学与技术 专业培养方案",
        "3、毕业学分要求\n必修131学分，选修27学分，总学分：158学分。",
        "六、指导性教学计划进程\n2. 专业教育\n（3）专业基础课\n"
        "课程号    课程名称          学分       考核方式 开课学期 修读要求\n"
        "A2041130 数据结构A          4         考试     3       必修★\n"
        "七、毕业要求实现矩阵",
    ])


def test_graph_returns_only_verified_catalog_courses(monkeypatch: pytest.MonkeyPatch) -> None:
    _store(monkeypatch, _catalog(), verified=True)

    result = server.handle_curriculum_graph("curriculum-cs-2026")

    assert result["ok"] is True
    assert result["data"]["courses"][1]["prerequisites"] == ["CS101"]
    assert result["data"]["total_credits"] is None


def test_graph_rejects_unextracted_document(monkeypatch: pytest.MonkeyPatch) -> None:
    _store(monkeypatch, None, verified=False)

    result = server.handle_curriculum_graph("curriculum-cs-2026")

    assert result["ok"] is False
    assert result["error"]["code"] == "CATALOG_NOT_READY"


def test_graph_rejects_unknown_prerequisite(monkeypatch: pytest.MonkeyPatch) -> None:
    catalog = _catalog()
    catalog["courses"][1]["prerequisites"] = ["MISSING"]
    _store(monkeypatch, catalog, verified=True)

    result = server.handle_curriculum_graph("curriculum-cs-2026")

    assert result["ok"] is False
    assert result["error"]["code"] == "CATALOG_NOT_READY"


def test_progress_is_saved_only_in_separate_anonymous_partition(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _store(monkeypatch, _catalog(), verified=True)
    monkeypatch.setattr(server, "progress_store", AnonymousProgressStore(tmp_path / "student_progress"))

    saved = server.handle_save_course_progress(
        PROFILE_ID, "curriculum-cs-2026", {"CS101": "passed", "CS201": "not_taken"}
    )
    loaded = server.handle_load_course_progress(PROFILE_ID, "curriculum-cs-2026")

    assert saved["ok"] is True
    assert loaded["data"]["course_statuses"] == {"CS101": "passed"}
    assert list((tmp_path / "student_progress").rglob("*.json"))


def test_progress_rejects_unknown_course_without_writing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _store(monkeypatch, _catalog(), verified=True)
    monkeypatch.setattr(server, "progress_store", AnonymousProgressStore(tmp_path / "student_progress"))

    result = server.handle_save_course_progress(PROFILE_ID, "curriculum-cs-2026", {"OTHER": "passed"})

    assert result["error"]["code"] == "INVALID_ARGUMENT"
    assert not list(tmp_path.rglob("*.json"))


def test_unverified_pdf_preview_can_save_anonymous_status_without_publishing_rules(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _preview_store(monkeypatch, tmp_path)
    monkeypatch.setattr(server, "progress_store", AnonymousProgressStore(tmp_path / "student_progress"))

    saved = server.handle_save_course_progress(
        PROFILE_ID, "curriculum-cs-2026", {"A2041130": "passed"}
    )
    loaded = server.handle_load_course_progress(PROFILE_ID, "curriculum-cs-2026")

    assert saved["ok"] is True
    assert loaded["data"]["course_statuses"] == {"A2041130": "passed"}
    assert server.handle_curriculum_graph("curriculum-cs-2026")["error"]["code"] == "CATALOG_NOT_READY"


def test_unverified_preview_rejects_an_unknown_course_without_creating_progress(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _preview_store(monkeypatch, tmp_path)
    monkeypatch.setattr(server, "progress_store", AnonymousProgressStore(tmp_path / "student_progress"))

    result = server.handle_save_course_progress(PROFILE_ID, "curriculum-cs-2026", {"OTHER": "passed"})

    assert result["error"]["code"] == "INVALID_ARGUMENT"
    assert not list((tmp_path / "student_progress").rglob("*.json"))


def test_progress_clear_requires_confirmation(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _store(monkeypatch, _catalog(), verified=True)
    monkeypatch.setattr(server, "progress_store", AnonymousProgressStore(tmp_path / "student_progress"))
    server.handle_save_course_progress(PROFILE_ID, "curriculum-cs-2026", {"CS101": "passed"})

    denied = server.handle_clear_course_progress(PROFILE_ID, "curriculum-cs-2026", False)
    cleared = server.handle_clear_course_progress(PROFILE_ID, "curriculum-cs-2026", True)

    assert denied["error"]["code"] == "INVALID_ARGUMENT"
    assert cleared["data"]["removed"] is True
    assert server.handle_load_course_progress(PROFILE_ID, "curriculum-cs-2026")["data"]["course_statuses"] == {}


def test_plan_uses_verified_document_rules_not_bundled_mock(monkeypatch: pytest.MonkeyPatch) -> None:
    _store(monkeypatch, _catalog(), verified=True)

    result = server.handle_course_path_plan({
        "document_id": "curriculum-cs-2026",
        "major": "computer-science",
        "grade": "2026",
        "completed_courses": [],
        "target_course": "CS201",
    })

    assert result["ok"] is True
    assert result["data"]["document_id"] == "curriculum-cs-2026"
    assert result["data"]["basic_advice"]["status"] == "NOT_ELIGIBLE"
    assert [course["course_code"] for course in result["data"]["missing_courses"]] == ["CS101"]
    assert result["sources"][0]["page"] == 7
    assert "COURSE_CATALOG_AUTO_VERIFIED" in result["warnings"]


def test_plan_rejects_unverified_document_without_mock_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    _store(monkeypatch, _catalog(), verified=False)

    result = server.handle_course_path_plan({
        "document_id": "curriculum-cs-2026",
        "major": "computer-science",
        "grade": "2026",
        "completed_courses": [],
        "target_course": "CS201",
    })

    assert result["ok"] is False
    assert result["error"]["code"] == "CATALOG_NOT_READY"
    assert result["data"] is None


def test_plan_rejects_cohort_mismatch(monkeypatch: pytest.MonkeyPatch) -> None:
    _store(monkeypatch, _catalog(), verified=True)

    result = server.handle_course_path_plan({
        "document_id": "curriculum-cs-2026",
        "major": "computer-science",
        "grade": "2025",
        "completed_courses": [],
        "target_course": "CS201",
    })

    assert result["error"]["code"] == "INVALID_ARGUMENT"
    assert result["error"]["details"]["reason"] == "cohort_mismatch"
