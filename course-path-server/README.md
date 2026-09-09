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

Inspector should list one tool named `course_path_plan`.

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
team-confirmed curriculum document must be reviewed and published as a
`verified` catalog before the tool is used for formal academic conclusions.

## Known limitations

- The MVP checks prerequisite relationships and basic recommendations only.
- It does not create an optimal multi-semester schedule or complex What-if
  plans.
- It does not parse PDF or image files directly; those sources must be
  reviewed and transformed into a structured course catalog first.
