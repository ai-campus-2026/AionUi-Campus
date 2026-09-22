"""Deterministic conversion of extracted TSV tables into catalog drafts."""

from __future__ import annotations

import csv
import json
import re
import unicodedata
from dataclasses import dataclass
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

HEADER_ALIASES = {
    "coursecode": "course_code",
    "课程代码": "course_code",
    "课程编号": "course_code",
    "课程号": "course_code",
    "coursename": "course_name",
    "课程名称": "course_name",
    "课程名": "course_name",
    "credits": "credits",
    "学分": "credits",
    "semester": "semester",
    "建议学期": "semester",
    "开设学期": "semester",
    "开课学期": "semester",
    "学期": "semester",
    "category": "category",
    "课程类别": "category",
    "课程性质": "category",
    "课程类型": "category",
    "修读要求": "category",
    "类别": "category",
    "prerequisites": "prerequisites",
    "先修课程": "prerequisites",
    "先修课": "prerequisites",
    "先修": "prerequisites",
    "page": "page",
    "页码": "page",
    "页": "page",
    "section": "section",
    "章节": "section",
    "所属章节": "section",
}


@dataclass(frozen=True)
class ProgramPlanParseError(Exception):
    """A public, non-technical failure for the front-end plan JSON contract."""

    code: str
    message: str


_PLAN_TITLE = re.compile(r"(?m)^\s*([^\n]{2,40}?)\s*专业培养方案\s*$")
_COURSE_LINE = re.compile(r"^\s*(?P<code>[A-Z]\d{6,8}[A-Z]?)\s+(?P<rest>.+)$")
_COURSE_CODE = re.compile(r"[A-Z]\d{6,8}[A-Z]?")
_NUMBER = re.compile(r"\d+(?:\.\d+)?")
_REQUIREMENT = re.compile(r"(必修|选修)★?\s*$")
_SEMESTER = re.compile(r"(?:考试|考查)\s+(S?\d+(?:[,，]\d+)*|春秋学期|每年)")
_SECTION = re.compile(r"^\s*[（(](\d+(?:\.\d+)?)[）)]\s*(\S.*)$")
_GRADUATION_CREDITS = re.compile(r"总学分\s*[:：]\s*(\d+(?:\.\d+)?)\s*学分")
_DISTRIBUTION_TOTAL = re.compile(r"(?m)^\s*合计\s+\d+\s+\d+\s+(\d+(?:\.\d+)?)\s+")


def parse_program_plan_pages(pages: list[str], *, grade: str, version: str | None = None) -> dict[str, Any]:
    """Build the front-end v2 JSON from literal PDF table cells only.

    Only an explicit per-course prerequisite column may establish display
    edges. An empty array otherwise means no relationship was established,
    not proof that the course has no prerequisite.
    This preview must not be published as a verified planning catalog.
    """
    if not pages or (grade and not re.fullmatch(r"20\d{2}", grade)):
        raise ProgramPlanParseError("PARSE_FAILED", "培养方案年级格式无效")
    title = _PLAN_TITLE.search(pages[0])
    if title is None or "指导性教学计划" not in "\n".join(pages):
        raise ProgramPlanParseError("NOT_A_PROGRAM_PLAN", "无法识别该文件为培养方案，请上传包含课程信息的培养方案文件")
    major = title.group(1).strip()
    document_text = "\n".join(pages[:6])
    total_match = _GRADUATION_CREDITS.search(document_text)
    if total_match is None:
        raise ProgramPlanParseError("PARSE_FAILED", "未找到明确的毕业总学分要求，请核对培养方案")
    total_credits = _clean_number(total_match.group(1))

    courses: list[dict[str, Any]] = []
    seen: set[str] = set()
    skipped = 0
    multi_semester = 0
    in_plan = False
    top_section = ""
    section = ""
    credit_column: int | None = None
    prerequisite_column = False
    raw_prerequisites: dict[str, list[str]] = {}
    invalid_prerequisites = 0
    for page in pages:
        for line in page.splitlines():
            if "六、指导性教学计划进程" in line:
                in_plan = True
                continue
            if not in_plan:
                continue
            if "七、毕业要求实现矩阵" in line:
                in_plan = False
                break
            top_match = re.match(r"^\s*\d+[.、]\s*(通识教育|专业教育)\s*$", line)
            if top_match:
                top_section = top_match.group(1)
                section = ""
                credit_column = None
                prerequisite_column = False
                continue
            section_match = _SECTION.match(line)
            if section_match:
                section = section_match.group(2).strip()
                if "." in section_match.group(1):
                    section = f"专业方向课·{section}"
                credit_column = None
                prerequisite_column = False
                continue
            if "课程号" in line and "课程名称" in line and "学分" in line:
                credit_column = line.index("学分")
                prerequisite_column = "先修课程" in line or "先修课" in line
                continue
            match = _COURSE_LINE.match(line)
            if match is None:
                continue
            requirement = _REQUIREMENT.search(line)
            semester_match = _SEMESTER.search(line)
            credit_matches = list(_NUMBER.finditer(line, match.start("rest")))
            credit_match = (
                min(credit_matches, key=lambda value: abs(value.start() - credit_column))
                if credit_column is not None and credit_matches else None
            )
            if not requirement or not semester_match:
                skipped += 1
                continue
            # A continuing table page can use a new column width without
            # repeating its header. Double-space cell boundaries preserve
            # names such as "通用学术英语 1" without treating 1 as credits.
            cells = re.split(r"\s{2,}", line.strip())
            first_cell = cells[0] if cells else ""
            cell_name = first_cell[len(match.group("code")):].strip()
            if (
                len(cells) >= 2
                and _NUMBER.fullmatch(cells[1])
                and 0 < float(cells[1]) <= 20
                and re.search(r"[^\d\s]", cell_name)
            ):
                name, credit_text = cell_name, cells[1]
            elif (
                credit_match is not None
                and credit_column is not None
                and abs(credit_match.start() - credit_column) <= 5
            ):
                name = line[match.start("rest"):credit_match.start()].strip()
                credit_text = credit_match.group()
            else:
                skipped += 1
                continue
            semester_tokens = re.findall(r"\d+", semester_match.group(1))
            if not name or not re.search(r"[^\d\s]", name) or not semester_tokens:
                skipped += 1
                continue
            semester = int(semester_tokens[0])
            credits = _clean_number(credit_text)
            if not 1 <= semester <= 8 or not 0 < credits <= 20:
                skipped += 1
                continue
            if len(semester_tokens) > 1:
                multi_semester += 1
            code = match.group("code")
            if code in seen:
                skipped += 1
                continue
            seen.add(code)
            category, category_label = _preview_category(top_section, section, requirement.group(1), line)
            if prerequisite_column:
                prerequisite_text = line[semester_match.end():requirement.start()].strip()
                if prerequisite_text in {"无", "-", "—", "不要求"}:
                    raw_prerequisites[code] = []
                else:
                    tokens = [token for token in re.split(r"[\s|,，、;/；]+", prerequisite_text) if token]
                    if tokens and all(_COURSE_CODE.fullmatch(token) for token in tokens):
                        raw_prerequisites[code] = tokens
                    else:
                        invalid_prerequisites += 1
            courses.append({
                "id": code,
                "name": name,
                "credits": credits,
                "category": category,
                "categoryLabel": category_label,
                "suggestedSemester": semester,
                "prerequisites": [],
            })
    if not courses:
        raise ProgramPlanParseError("PARSE_FAILED", "未从培养方案中读到完整课程表，请使用文字版 PDF")

    by_code = {course["id"]: course for course in courses}
    relation_count = 0
    for course in courses:
        for prerequisite in raw_prerequisites.get(course["id"], []):
            earlier = by_code.get(prerequisite)
            if earlier is None or earlier["suggestedSemester"] >= course["suggestedSemester"]:
                invalid_prerequisites += 1
                continue
            if prerequisite not in course["prerequisites"]:
                course["prerequisites"].append(prerequisite)
                relation_count += 1

    if relation_count:
        warnings = [
            f"从文件的先修课程列读取到 {relation_count} 条关系；这是未复核预览，不能单独作为选课资格依据。"
        ]
    else:
        warnings = ["课程表未提供可核实的逐门先修关系；当前图仅展示课程节点，不能据此判断选课资格。"]
    if invalid_prerequisites:
        warnings.append(f"{invalid_prerequisites} 条先修关系因课程号不明确、未收录或学期顺序冲突而未绘制。")
    distribution_match = _DISTRIBUTION_TOTAL.search(document_text)
    if distribution_match and _clean_number(distribution_match.group(1)) != total_credits:
        warnings.append(
            f"毕业学分存在矛盾：正文为 {total_credits} 学分，课程分配表合计为 "
            f"{_clean_number(distribution_match.group(1))} 学分；请核对学校正式版本。"
        )
    if skipped:
        warnings.append(f"{skipped} 条课程行因缺少名称、学分、明确学期或修读要求而未纳入图中。")
    if multi_semester:
        warnings.append(f"{multi_semester} 门课程列出多个开课学期，图中暂按第一个学期显示。")
    result: dict[str, Any] = {
        "success": True,
        "major": major,
        "grade": grade or "未注明",
        "totalCredits": total_credits,
        "courses": courses,
        "warnings": warnings,
    }
    if version:
        result["version"] = version
    return result


def validate_recommended_sequences(
    model_result: dict[str, Any], courses: list[dict[str, Any]], *, page: int
) -> tuple[list[dict[str, int | str]], int]:
    """Keep only well-identified, forward visual arrows; never write prerequisites."""
    by_label: dict[str, list[dict[str, Any]]] = {}
    for course in courses:
        normalized = _normalize_flow_label(course["name"])
        by_label.setdefault(normalized, []).append(course)
    accepted: list[dict[str, int | str]] = []
    seen: set[tuple[str, str]] = set()
    rejected = 0
    candidates = model_result.get("edges", [])
    for candidate in candidates[:20]:
        if not isinstance(candidate, dict):
            rejected += 1
            continue
        from_label = candidate.get("fromLabel")
        to_label = candidate.get("toLabel")
        if not isinstance(from_label, str) or not isinstance(to_label, str):
            rejected += 1
            continue
        sources = by_label.get(_normalize_flow_label(from_label), [])
        targets = by_label.get(_normalize_flow_label(to_label), [])
        if len(sources) != 1 or len(targets) != 1:
            rejected += 1
            continue
        source, target = sources[0], targets[0]
        source_id, target_id = source["id"], target["id"]
        if (
            source_id == target_id
            or (isinstance(candidate.get("fromId"), str) and candidate["fromId"] != source_id)
            or (isinstance(candidate.get("toId"), str) and candidate["toId"] != target_id)
            or source["suggestedSemester"] >= target["suggestedSemester"]
            or (source_id, target_id) in seen
        ):
            rejected += 1
            continue
        seen.add((source_id, target_id))
        accepted.append({"from": source_id, "to": target_id, "page": page})
    return accepted, rejected + max(0, len(candidates) - 20)


def _normalize_flow_label(label: str) -> str:
    """Match a diagram's exact course name despite whitespace and core-course stars."""
    normalized = unicodedata.normalize("NFKC", label).casefold()
    return re.sub(r"[\s★☆]", "", normalized)


def _clean_number(value: str) -> int | float:
    parsed = float(value)
    return int(parsed) if parsed.is_integer() else parsed


def _preview_category(top_section: str, section: str, requirement: str, raw_line: str) -> tuple[str, str]:
    if "★" in raw_line:
        return "core", "专业核心课"
    if "实践" in section or "实践" in raw_line or "实习" in raw_line or "课程设计" in raw_line:
        return "practice", section or "实践课程"
    if requirement == "选修":
        return "elective", section or "选修课"
    if top_section == "通识教育":
        return "general", section or "通识教育"
    return "required", section or "必修课"


def extract_catalog_draft(
    input_data: CurriculumExtractInput,
    *,
    allow_incomplete: bool = False,
) -> dict[str, Any]:
    """Parse a curriculum table into an unpublished catalog draft.

    Manual TSV imports remain strict. Model-assisted document interpretation
    may retain incomplete rows so a missing field does not erase an otherwise
    useful course record; deterministic validation still prevents such a draft
    from becoming a planning catalog.
    """
    reader = csv.DictReader(StringIO(_normalize_table_text(input_data.course_table_tsv)), delimiter="\t")
    if reader.fieldnames is None:
        raise _table_error("header_required")

    headers = tuple(header.strip() for header in reader.fieldnames if header is not None)
    missing_columns = [column for column in REQUIRED_COLUMNS if column not in headers]
    if missing_columns:
        raise _table_error("required_columns_missing", {"columns": missing_columns})

    courses: list[dict[str, Any]] = []
    extraction_warnings: list[str] = []
    for row_number, row in enumerate(reader, start=2):
        parsed = _parse_course_row(row, row_number, allow_incomplete=allow_incomplete)
        if parsed is None:
            extraction_warnings.append(f"COURSE_ROW_SKIPPED:{row_number}")
            continue
        course, row_warnings = parsed
        courses.append(course)
        extraction_warnings.extend(row_warnings)

    if not courses:
        raise _table_error("course_rows_required")

    catalog = {
        "catalog_id": input_data.catalog_id or _default_catalog_id(input_data),
        "data_status": "draft",
        "document": input_data.document,
        "major": input_data.major,
        "cohort": input_data.cohort,
        "version": input_data.version,
        "extraction_method": "tsv_table_import",
        "courses": courses,
    }
    if extraction_warnings:
        catalog["extraction_warnings"] = list(dict.fromkeys(extraction_warnings))
    return catalog


def _parse_course_row(
    row: dict[str | None, str | None],
    row_number: int,
    *,
    allow_incomplete: bool,
) -> tuple[dict[str, Any], list[str]] | None:
    values = {key.strip() if key is not None else "": (value or "").strip() for key, value in row.items()}
    identity_missing = [column for column in ("course_code", "course_name") if not values[column]]
    if identity_missing and allow_incomplete:
        return None

    missing_values = [column for column in ("course_code", "course_name", "credits", "semester", "category") if not values[column]]
    if missing_values:
        if not allow_incomplete:
            raise _table_error("course_values_missing", {"row": row_number, "columns": missing_values})

    warnings = [
        f"COURSE_FIELD_MISSING:{values['course_code'] or row_number}:{column}"
        for column in missing_values
        if column not in identity_missing
    ]

    credits = _parse_lenient_number(values["credits"], row_number, "credits", allow_incomplete, warnings)
    semester = _parse_lenient_semester(values["semester"], row_number, allow_incomplete, warnings)
    prerequisite_value: list[str] | None
    if allow_incomplete and values["prerequisites"] == "?":
        prerequisite_value = None
        warnings.append(f"COURSE_FIELD_MISSING:{values['course_code']}:prerequisites")
    else:
        prerequisite_value = [code.strip() for code in values["prerequisites"].split("|") if code.strip()]

    return (
        {
            "course_code": values["course_code"],
            "course_name": values["course_name"],
            "credits": credits,
            "semester": semester,
            "category": values["category"] or None,
            "prerequisites": prerequisite_value,
            "page": _parse_page(values["page"], row_number),
            "section": values["section"] or None,
        },
        warnings,
    )


def _parse_lenient_number(
    value: str,
    row_number: int,
    field: str,
    allow_incomplete: bool,
    warnings: list[str],
) -> int | float | None:
    if not allow_incomplete:
        return _parse_credits(value, row_number)
    if not value:
        return None
    try:
        parsed = _parse_credits(value, row_number)
    except CurriculumExtractError:
        warnings.append(f"COURSE_FIELD_UNPARSED:{row_number}:{field}")
        return None
    return parsed


def _parse_lenient_semester(
    value: str,
    row_number: int,
    allow_incomplete: bool,
    warnings: list[str],
) -> int | None:
    if not allow_incomplete:
        return _parse_semester(value, row_number)
    if not value:
        return None
    try:
        return _parse_semester(value, row_number)
    except CurriculumExtractError:
        warnings.append(f"COURSE_FIELD_UNPARSED:{row_number}:semester")
        return None


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


def _normalize_table_text(table_text: str) -> str:
    """Normalize common OCR table wrappers without accepting unstructured prose."""
    table_text = _coerce_json_table(table_text)
    lines = [line.rstrip() for line in table_text.strip().splitlines() if line.strip() and line.strip() != "```"]
    for index, line in enumerate(lines):
        header = _split_table_line(line)
        normalized_header = [_normalize_header(cell) for cell in header]
        if len(set(normalized_header) & set(REQUIRED_COLUMNS)) < 4:
            continue

        data_lines = lines[index + 1 :]
        if data_lines and _is_markdown_separator(_split_table_line(data_lines[0])):
            data_lines = data_lines[1:]
        normalized_lines = ["\t".join(normalized_header)]
        normalized_lines.extend("\t".join(_split_table_line(data_line)) for data_line in data_lines)
        return "\n".join(normalized_lines)
    return table_text


def classify_table_output(table_text: str) -> str:
    """Classify a model table response without returning any of its content."""
    stripped = table_text.strip()
    try:
        json.loads(stripped)
    except json.JSONDecodeError:
        pass
    else:
        return "json"
    if "<table" in stripped.lower():
        return "html_table"
    if "|" in stripped:
        return "markdown_table"
    if "\t" in stripped:
        return "tsv"
    return "plain_text"


def add_missing_source_page(table_text: str, source_page: int | None) -> str:
    """Fill only absent page evidence when one model call represents one known source page."""
    if source_page is None:
        return table_text
    try:
        payload = json.loads(table_text.strip())
    except json.JSONDecodeError:
        return table_text
    records = _find_course_records(payload)
    if records is None:
        return table_text
    for record in records:
        if record.get("page") in (None, ""):
            record["page"] = source_page
    return json.dumps(payload, ensure_ascii=False)


def _coerce_json_table(table_text: str) -> str:
    """Convert a common model JSON course array to the same internal TSV contract."""
    try:
        payload = json.loads(table_text.strip())
    except json.JSONDecodeError:
        return table_text

    if isinstance(payload, dict):
        for key in ("course_table_tsv", "tsv", "table"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value
    records = _find_course_records(payload)
    if records is None:
        return table_text

    output = StringIO()
    writer = csv.DictWriter(output, fieldnames=REQUIRED_COLUMNS, delimiter="\t", lineterminator="\n")
    writer.writeheader()
    for record in records:
        row = {column: "" for column in REQUIRED_COLUMNS}
        for key, value in record.items():
            normalized_key = _normalize_header(str(key))
            if normalized_key in row:
                row[normalized_key] = _serialize_cell(value, field=normalized_key)
        writer.writerow(row)
    return output.getvalue()


def _find_course_records(payload: object) -> list[dict[str, Any]] | None:
    """Find a course-record array in a model JSON object without guessing fields."""
    if isinstance(payload, list) and all(isinstance(item, dict) for item in payload):
        return payload
    if not isinstance(payload, dict):
        return None
    for key in ("courses", "rows", "data"):
        value = payload.get(key)
        if isinstance(value, list) and all(isinstance(item, dict) for item in value):
            return value
        if isinstance(value, dict):
            nested = _find_course_records(value)
            if nested is not None:
                return nested
    return None


def _serialize_cell(value: object, *, field: str) -> str:
    if value is None:
        return "?" if field == "prerequisites" else ""
    if isinstance(value, list):
        return "|".join(str(item).strip() for item in value if str(item).strip())
    return str(value).strip()


def _split_table_line(line: str) -> list[str]:
    """Split either TSV or a simple Markdown table row into cells."""
    stripped = line.strip()
    if "\t" in stripped:
        return [cell.strip() for cell in stripped.split("\t")]
    if "|" in stripped:
        if stripped.startswith("|"):
            stripped = stripped[1:]
        if stripped.endswith("|"):
            stripped = stripped[:-1]
        return [cell.strip() for cell in stripped.split("|")]
    return [stripped]


def _normalize_header(value: str) -> str:
    """Map common English and Chinese OCR headers to the catalog contract."""
    compact = re.sub(r"[\s_\-()（）:：]", "", value).lower()
    return HEADER_ALIASES.get(compact, value.strip())


def _is_markdown_separator(cells: list[str]) -> bool:
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell) is not None for cell in cells)


def _table_error(reason: str, details: dict[str, Any] | None = None) -> CurriculumExtractError:
    return CurriculumExtractError(
        code="INVALID_ARGUMENT",
        message="培养方案表格格式无效",
        details={"reason": reason, **(details or {})},
    )
