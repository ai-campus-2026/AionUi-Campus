"""The front-end plan preview contract must use evidence, not guessed rules."""

from __future__ import annotations

import hashlib
import sys
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

import pytest
import pdfplumber
from PyPDF2 import PdfWriter

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

import server
from tools.attachment_extract import _flow_diagram_bounds, rendered_plan_flow_page
from tools.curriculum_extract import ProgramPlanParseError, parse_program_plan_pages, validate_recommended_sequences


def _pages() -> list[str]:
    return [
        "计算机科学与技术 专业培养方案\n一、专业介绍",
        "3、毕业学分要求\n必修131学分，选修27学分，总学分：158学分。\n合计 133 27 160 101.3%",
        "\n".join(
            [
                "六、指导性教学计划进程",
                "1. 通识教育",
                "（1）思想政治理论课",
                "课程号    课程名称          学分       考核方式 开课学期 修读要求",
                "A1100015 形势与政策        1         考查     1,4     必修",
                "2. 专业教育",
                "（3）专业基础课",
                "课程号    课程名称          学分       考核方式 开课学期 修读要求",
                "A2041130 数据结构A          4         考试     3       必修★",
                "七、毕业要求实现矩阵",
            ]
        ),
    ]


def test_contract_exports_evidence_based_courses_with_no_invented_edges() -> None:
    result = parse_program_plan_pages(_pages(), grade="2026", version="2026.1")

    assert result["success"] is True
    assert result["totalCredits"] == 158
    assert [course["id"] for course in result["courses"]] == ["A1100015", "A2041130"]
    assert result["courses"][1]["category"] == "core"
    assert all(course["prerequisites"] == [] for course in result["courses"])
    assert any("160" in warning for warning in result["warnings"])


def test_explicit_course_code_column_creates_only_valid_prerequisite_edges() -> None:
    pages = [
        "计算机科学与技术（模拟） 专业培养方案",
        "毕业学分要求\n必修15学分，选修0学分，总学分：15学分。",
        "\n".join([
            "六、指导性教学计划进程",
            "2. 专业教育",
            "（3）专业基础课",
            "课程号    课程名称          学分       考核方式 开课学期 先修课程 修读要求",
            "A2040190 C语言程序设计       3         考试     1       无 必修",
            "A2040220 离散数学          3         考试     2       无 必修",
            "A2041130 数据结构A          4         考试     3       A2040190|A2040220 必修★",
            "A2040240 数据库原理         3         考试     4       A2041130|A9999999 必修",
            "A2040250 课程设计          2         考试     2       A2040240 必修",
            "七、毕业要求实现矩阵",
        ]),
    ]

    result = parse_program_plan_pages(pages, grade="2026")

    by_id = {course["id"]: course for course in result["courses"]}
    assert by_id["A2041130"]["prerequisites"] == ["A2040190", "A2040220"]
    assert by_id["A2040240"]["prerequisites"] == ["A2041130"]
    assert by_id["A2040250"]["prerequisites"] == []
    assert any("3 条关系" in warning for warning in result["warnings"])
    assert any("2 条先修关系" in warning for warning in result["warnings"])


def test_non_program_document_is_rejected() -> None:
    with pytest.raises(ProgramPlanParseError) as error:
        parse_program_plan_pages(["普通通知", "总学分：158学分"], grade="2026")

    assert error.value.code == "NOT_A_PROGRAM_PLAN"


def test_continuing_table_page_keeps_course_name_and_credit_separate() -> None:
    pages = _pages()
    pages[2] = pages[2].replace("七、毕业要求实现矩阵", "")
    pages.append(
        "A1050370 通用学术英语 1                      3        48  考试    1,2    必修\n"
        "A1050062 综合英语           2         32       0   考试    3          选修\n"
        "七、毕业要求实现矩阵"
    )

    result = parse_program_plan_pages(pages, grade="2026")

    by_code = {course["id"]: course for course in result["courses"]}
    assert by_code["A1050370"]["name"] == "通用学术英语 1"
    assert by_code["A1050370"]["credits"] == 3
    assert by_code["A1050062"]["credits"] == 2


def test_missing_grade_is_not_guessed() -> None:
    with pytest.raises(ProgramPlanParseError) as error:
        parse_program_plan_pages(_pages(), grade="")

    assert error.value.code == "PARSE_FAILED"


def test_file_path_handler_uses_registered_cohort_without_model_call(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source = tmp_path / "curriculum.pdf"
    source.write_bytes(b"%PDF-1.7 test")
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    monkeypatch.setattr(server, "curriculum_store", SimpleNamespace(list_documents=lambda: [
        {"sha256": digest, "cohort": "2026", "version": "2026.1"}
    ]))
    monkeypatch.setattr(server, "native_pdf_pages_for_plan", lambda _path: _pages())
    monkeypatch.setattr(server, "DashScopeClient", lambda _config: pytest.fail("model should not be called"))

    result = server.handle_parse_program_plan(str(source), "untrusted-name.pdf")

    assert result["success"] is True
    assert result["grade"] == "2026"
    assert result["version"] == "2026.1"
    assert len(result["courses"]) == 2


def test_handler_returns_only_failure_fields_for_unsupported_file(tmp_path: Path) -> None:
    source = tmp_path / "curriculum.docx"
    source.write_bytes(b"not a pdf")

    assert server.handle_parse_program_plan(str(source)) == {
        "success": False,
        "errorCode": "UNSUPPORTED_FORMAT",
        "errorMessage": "当前仅支持可复制文字的 PDF 培养方案",
    }


def test_unregistered_pdf_without_year_returns_failure_instead_of_guessing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source = tmp_path / "curriculum.pdf"
    source.write_bytes(b"%PDF-1.7 test")
    monkeypatch.setattr(server, "curriculum_store", SimpleNamespace(list_documents=lambda: []))
    monkeypatch.setattr(server, "native_pdf_pages_for_plan", lambda _path: _pages())

    result = server.handle_parse_program_plan(str(source))

    assert result["success"] is False
    assert result["errorCode"] == "PARSE_FAILED"
    assert "courses" not in result


def test_visual_flow_candidates_never_become_formal_prerequisites() -> None:
    courses = parse_program_plan_pages(_pages(), grade="2026")["courses"]
    candidates = {"edges": [
        {"fromId": "A1100015", "toId": "A2041130", "fromLabel": "形势与政策", "toLabel": "数据结构A"},
        {"fromId": "A2041130", "toId": "A1100015", "fromLabel": "数据结构A", "toLabel": "形势与政策"},
        {"fromId": "A1100015", "toId": "MISSING", "fromLabel": "形势与政策", "toLabel": "未知课程"},
    ]}

    edges, rejected = validate_recommended_sequences(candidates, courses, page=5)

    assert edges == [{"from": "A1100015", "to": "A2041130", "page": 5}]
    assert rejected == 2
    assert all(course["prerequisites"] == [] for course in courses)


def test_diagram_labels_map_to_unique_courses_without_model_supplied_ids() -> None:
    courses = parse_program_plan_pages(_pages(), grade="2026")["courses"]

    edges, rejected = validate_recommended_sequences(
        {"edges": [{"fromLabel": "形势 与政策", "toLabel": "数据结构A★"}]}, courses, page=5
    )

    assert edges == [{"from": "A1100015", "to": "A2041130", "page": 5}]
    assert rejected == 0


def test_ambiguous_diagram_label_does_not_create_a_course_relation() -> None:
    courses = parse_program_plan_pages(_pages(), grade="2026")["courses"]
    courses.append({**courses[0], "id": "A1100016"})

    edges, rejected = validate_recommended_sequences(
        {"edges": [{"fromLabel": "形势与政策", "toLabel": "数据结构A"}]}, courses, page=5
    )

    assert edges == []
    assert rejected == 1


def test_diagram_page_rendering_removes_temporary_image(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source = tmp_path / "plan.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=300, height=200)
    with source.open("wb") as output:
        writer.write(output)
    monkeypatch.setattr("tools.attachment_extract.TEMP_ROOT", tmp_path / "temporary")

    with rendered_plan_flow_page(source, 1) as image:
        assert image["type"] == "image_url"
        assert len(image["image_url"]["url"]) > 100

    assert list((tmp_path / "temporary").iterdir()) == []


def test_diagram_crop_excludes_surrounding_pdf_sections(monkeypatch: pytest.MonkeyPatch) -> None:
    page = SimpleNamespace(
        height=841,
        search=lambda heading: [{"top": 100, "bottom": 110}]
        if heading == "课程体系配置流程图" else [{"top": 500, "bottom": 510}],
    )
    monkeypatch.setattr(pdfplumber, "open", lambda _source: nullcontext(SimpleNamespace(pages=[page])))

    assert _flow_diagram_bounds(Path("plan.pdf"), 1) == (85, 495)


def test_handler_returns_preview_when_diagram_model_is_unavailable(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source = tmp_path / "curriculum-2026.pdf"
    source.write_bytes(b"%PDF-1.7 test")
    pages = _pages()
    pages[1] += "\n五、课程体系配置流程图"
    monkeypatch.setattr(server, "curriculum_store", SimpleNamespace(list_documents=lambda: []))
    monkeypatch.setattr(server, "native_pdf_pages_for_plan", lambda _path: pages)
    monkeypatch.setattr(server, "rendered_plan_flow_page", lambda _path, _page: nullcontext({"type": "image_url"}))
    monkeypatch.setattr(server.DashScopeConfig, "from_file", lambda _path: object())
    monkeypatch.setattr(server, "DashScopeClient", lambda _config: SimpleNamespace(
        extract_recommended_sequences=lambda _image, _courses: (_ for _ in ()).throw(
            server.DashScopeError("MODEL_REQUEST_FAILED", "failed", {})
        )
    ))

    result = server.handle_parse_program_plan(str(source), include_flow=True)

    assert result["success"] is True
    assert result["recommendedSequences"] == []
    assert len(result["courses"]) == 2
    assert any("流程图识别暂不可用" in warning for warning in result["warnings"])


def test_handler_returns_visual_sequence_without_promoting_it_to_prerequisite(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source = tmp_path / "curriculum-2026.pdf"
    source.write_bytes(b"%PDF-1.7 test")
    pages = _pages()
    pages[1] += "\n五、课程体系配置流程图"
    monkeypatch.setattr(server, "curriculum_store", SimpleNamespace(list_documents=lambda: []))
    monkeypatch.setattr(server, "native_pdf_pages_for_plan", lambda _path: pages)
    monkeypatch.setattr(server, "rendered_plan_flow_page", lambda _path, _page: nullcontext({"type": "image_url"}))
    monkeypatch.setattr(server.DashScopeConfig, "from_file", lambda _path: object())
    monkeypatch.setattr(server, "DashScopeClient", lambda _config: SimpleNamespace(
        extract_recommended_sequences=lambda _image, _courses: {"edges": [
            {"fromLabel": "形势与政策", "toLabel": "数据结构A★"}
        ]}
    ))

    result = server.handle_parse_program_plan(str(source), include_flow=True)

    assert result["recommendedSequences"] == [{"from": "A1100015", "to": "A2041130", "page": 2}]
    assert all(course["prerequisites"] == [] for course in result["courses"])


def test_handler_keeps_recommended_sequence_separate_from_rules(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source = tmp_path / "curriculum-2026.pdf"
    source.write_bytes(b"%PDF-1.7 test")
    pages = _pages()
    pages[1] += "\n五、课程体系配置流程图"
    monkeypatch.setattr(server, "curriculum_store", SimpleNamespace(list_documents=lambda: []))
    monkeypatch.setattr(server, "native_pdf_pages_for_plan", lambda _path: pages)
    monkeypatch.setattr(server, "rendered_plan_flow_page", lambda _path, _page: nullcontext({"type": "image_url"}))
    monkeypatch.setattr(server.DashScopeConfig, "from_file", lambda _path: object())
    monkeypatch.setattr(server, "DashScopeClient", lambda _config: SimpleNamespace(
        extract_recommended_sequences=lambda _image, _courses: {"edges": [
            {"fromId": "A1100015", "toId": "A2041130", "fromLabel": "形势与政策", "toLabel": "数据结构A"}
        ]}
    ))

    result = server.handle_parse_program_plan(str(source), include_flow=True)

    assert result["recommendedSequences"] == [{"from": "A1100015", "to": "A2041130", "page": 2}]
    assert all(course["prerequisites"] == [] for course in result["courses"])
