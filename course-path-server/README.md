# Course Path Server

`course_path_plan` is a Python MCP tool that evaluates a student's target
course using a versioned, structured course catalog. It deterministically
reports missing courses, direct prerequisite conflicts, and a basic next-step
recommendation. It does not use an LLM to infer course rules.

## Requirements

- Python 3.12
- Stdio-compatible MCP client, such as MCP Inspector or AionUi

## Install

From this directory, create an isolated local environment and install the
declared dependencies:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

`.venv/` and `.env` are local-only and are ignored by Git.

## Run

The server uses stdio. Do not write application output to stdout, because it
is reserved for MCP JSON-RPC messages.

```powershell
.\.venv\Scripts\python.exe server.py
```

## Test

Run the focused test suite from `course-path-server/`:

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

## MCP Inspector

```powershell
npx @modelcontextprotocol/inspector .\.venv\Scripts\python.exe server.py
```

Inspector should list `course_path_plan`, `catalog_validate`,
`curriculum_extract`, and `catalog_review`.

`catalog_validate` is a read-only administrative tool for checking
an extracted or manually entered catalog draft. It never publishes or writes a
catalog file.

## Input example

```json
{
  "major": "software-engineering",
  "grade": "2026",
  "completed_courses": ["SE101", "SE102", "SE201", "SE202", "SE301"],
  "target_course": "SE401"
}
```

`goal` is accepted as an alias for `target_course`. `planned_courses` is an
optional list used to check direct prerequisite conflicts for additional
planned courses.

`attachment_path` is optional. During V0.1, it is only read-only validated;
course planning still uses the structured fields above. The server never
copies, moves, deletes, logs, or returns the full path of an attachment.

## Attachment safety

Set `COURSE_PATH_ATTACHMENT_ROOT` locally to one controlled absolute folder,
for example `D:/CampusFiles`. The optional `attachment_path` must resolve
inside that folder, be a regular `.pdf`, `.png`, `.jpg`, or `.jpeg` file, and
be no larger than 20 MB. The server reads it only to validate the file and
calculate a content hash; it does not persist the attachment.

If an attachment is absent or rejected, `course_path_plan` still runs from
the submitted structured parameters and returns an attachment warning. This
keeps the existing MVP available while file extraction is added later.

## Output example

```json
{
  "schema_version": "0.1",
  "ok": true,
  "data": {
    "missing_courses": [{ "course_code": "SE302" }],
    "prerequisite_conflicts": [
      {
        "course": { "course_code": "SE401" },
        "missing_direct_prerequisites": [{ "course_code": "SE302" }]
      }
    ],
    "basic_advice": {
      "status": "NOT_ELIGIBLE",
      "next_actions": ["COMPLETE_DIRECT_PREREQUISITES"]
    }
  },
  "sources": [
    {
      "document": "软件工程专业培养方案（公开样例）",
      "section": "课程设置与先修关系",
      "page": null,
      "content": null,
      "chunk_index": null,
      "score": null
    }
  ],
  "warnings": ["COURSE_CATALOG_NOT_VERIFIED"],
  "error": null,
  "meta": {
    "tool": "course_path_plan"
  }
}
```

For failed validation, the server returns `ok: false`, `data: null`, and an
error object such as `INVALID_ARGUMENT` or `COURSE_NOT_FOUND`.

## Course catalog

`data/course_catalog.json` is the runtime source of course rules. Each
course should include at least:

```text
document, major, cohort/version, course_code, course_name, credits,
semester, category, prerequisites, page/section
```

The current catalog is a public-style mock dataset marked with
`"data_status": "mock"`. It is suitable for development and tests only. A
catalog can become `auto_verified` only after successful structural validation
and a passing structured model review; that state is still returned with an
explicit non-official warning.

## Catalog validation

`catalog_validate` accepts a complete catalog JSON object and returns
`data.valid`, diagnostics in `data.errors`, and non-blocking diagnostics in
`warnings`. It checks required fields, duplicate course codes, prerequisite
references, prerequisite cycles, and prerequisite semester ordering.

Use this tool before automatic model review. A `draft` or `mock` catalog can
be structurally valid, but it still produces a not-verified warning and must
not be treated as a formal curriculum source.

## Curriculum extraction draft

`curriculum_extract` converts an already extracted tab-separated table into a
`draft` catalog and validates it immediately. This first version deliberately
does not open PDF or image files and does not call an OCR or LLM provider.

The `course_table_tsv` value must use a header row followed by one row per
course. The required columns are:

```text
course_code  course_name  credits  semester  category  prerequisites  page  section
```

Columns are separated by tab characters. Multiple prerequisite codes in one
row use `|`; an empty prerequisite field means that the course has none.

Example table text:

```text
course_code	course_name	credits	semester	category	prerequisites	page	section
SE101	程序设计基础	3	1	专业基础课		1	课程设置
SE201	数据结构	4	2	专业核心课	SE101	2	课程设置
```

The tool returns the unpublished catalog in `data.catalog` and its diagnostics
in `data.validation`. It always marks generated data as `draft`.

## Automatic catalog review

`catalog_review` is the automatic decision layer after a vision/OCR model has
reviewed an extracted catalog against its source document. It combines the
deterministic validation result with a structured model report. It never
accepts unstructured prose as a decision and never writes a catalog to disk.

A model report has this shape:

```json
{
  "model": "configured-vision-reviewer",
  "overall_confidence": 0.95,
  "findings": []
}
```

Each finding has `code`, `message`, `severity` (`low`, `medium`, `high`, or
`blocking`), optional `course_code` and `field`, and optional source evidence.
The catalog becomes `auto_verified` only when structural validation succeeds,
there are no high/blocking findings, and `overall_confidence` is at least
`0.90`. `auto_verified` is still not an official school publication and
therefore returns an explicit warning.

This phase defines and tests the safe decision boundary; it does not yet call a
specific model provider. A subsequent provider adapter will send the PDF/image
and draft to the team-selected vision model, then pass its JSON report here.

## Known limitations

- The MVP checks prerequisite relationships and basic recommendations only.
- It does not create an optimal multi-semester schedule or complex What-if
  plans.
- It does not parse PDF or image files directly or call a model provider yet.
