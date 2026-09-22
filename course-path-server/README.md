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
`curriculum_extract`, `catalog_review`, and
`curriculum_extract_from_attachment`, `curriculum_ingest_from_attachment`,
`curriculum_index_document`, `retry_curriculum_extraction`, `curriculum_model_check`,
`list_curriculum_documents`, and
`get_curriculum_document`, `curriculum_search`, and
`clear_curriculum_knowledge_base`.

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

The server reads only the exact `attachment_path` passed to the tool. It never
scans folders, accepts directories, moves, or deletes the original attachment.
The file must be a regular `.pdf`, `.png`, `.jpg`, or `.jpeg` file no larger
than 20 MB. This allows AionUi's uploaded-file path and a local desktop path to
use the same import workflow without per-machine attachment-root configuration.

If an attachment is absent or rejected, `course_path_plan` still runs from
the submitted structured parameters and returns an attachment warning. This
keeps the existing MVP available while file extraction is added later.

## Model-assisted attachment extraction

`curriculum_extract_from_attachment` is the opt-in transient pipeline for a
checked local PDF/image. For a PDF, it extracts native text locally using a
multi-engine chain (`pdftotext`, PyPDF2, then pdfplumber), selects likely
course-table pages, and sends each bounded native-text page separately to
`qwen3.8-flash` for a structured JSON
course array. Currently each native-text request contains only one page: a
large multi-page response previously ended with `protocol_failed`. An invalid
page result receives one repair request; only then does its page image become
a visual fallback. This can require more calls than a combined request, but
keeps successful pages independent of a later page's failure.

Model requests use the same DashScope OpenAI-compatible SDK transport as
`policy-search`. Extraction and review responses are received as a stream to
avoid waiting for the entire JSON before the connection produces data. An
interrupted stream is rejected, never treated as a partial course catalog.
Timeouts and retryable HTTP responses use at most two attempts
with exponential backoff; connection-class failures return after one attempt.
If a page request fails because of TLS, DNS, timeout,
or another connection error, a circuit breaker marks the remaining pages and
stops issuing duplicate requests. The result reports `EXTRACTION_COMPLETE`,
`EXTRACTION_PARTIAL`, or `EXTRACTION_FAILED`, together with `pages_attempted`,
successful pages, and failed-page diagnostics. Zero successful pages can no
longer be labeled partial. Incomplete course rows retain readable course codes
and names, while missing fields produce validation errors and can never be
auto-published as planning rules. Review is skipped for partial, failed, or
structurally invalid catalogs to avoid spending model tokens on an incomplete
draft.

Before repeating a failed full-document extraction, call
`curriculum_model_check`. It sends one tiny request to the configured extraction
model with an 8-second timeout, without any document or student content. A
failed check returns only a safe reason such as `proxy_failed`, `tls_failed`,
`dns_resolution_failed`, `socket_permission_denied`, or `connection_failed`;
it never returns the API key or raw provider response. Connection-class
failures are not automatically retried; timeouts and retryable HTTP statuses
retain the bounded retry policy. The next-actions list points to this check
when document extraction fails at the model transport layer. A successful
check confirms only that a small request reached the model, not that a full
PDF extraction or catalog review will succeed.

The non-secret settings are committed in `data/model_config.json`. The
runtime reads `DASHSCOPE_API_KEY` only from the local process environment; it
does not load, log, return, or commit a key. A missing key returns
`MODEL_NOT_CONFIGURED` without disclosing configuration values.

For images, the adapter sends a Base64 data URL and therefore limits each model
input image to 7 MB. PDFs are rendered to at most five scaled PNG pages in an
automatically removed temporary directory. Before rendering, the server uses
transient local PDF text only to prefer pages containing both a course-table
heading and course codes; it falls back to the first five pages when no such
pages can be found. The bounded text for a selected page is supplied as
extraction context. The transient tool returns bounded source previews with
page and chunk identifiers but does not persist them. It never overwrites
`data/course_catalog.json`.

## Shared curriculum knowledge base

`curriculum_ingest_from_attachment` is the fast persistent entry point. It is
only for shared curriculum-plan PDFs or images, never transcripts, student
records, completed-course lists, names, or student IDs. It validates the exact
file, copies it into this server's `curriculum_knowledge_base/` partition, and
records its metadata by `major`, `cohort`, and `version`.

When the user uploads a document in AionUi and says “导入培养方案” (with the
major, cohort, and version), the Agent should call this tool using the current
upload's managed local path. The user should not need to type that path. This
path is injected by AionUi, so the user does not need to manage an attachment
directory.

The original attachment is never moved, changed, or deleted. Its complete
original path is not saved in the index or returned by the tool. Re-uploading
the same file for the same major/cohort/version reuses the existing record.
Ingest deliberately does not call DashScope, create embeddings, or extract a
course catalog. A successful response therefore returns quickly with
`storage_status: "SOURCE_STORED"`, current RAG/extraction states, and explicit
`next_actions`.

Call `curriculum_index_document` with the returned `document_id` to build a
portable local evidence index. Every native PDF page is split at Chinese
paragraph and sentence boundaries into bounded overlapping chunks and stored
as JSON beside the managed source. The default path does not open Chroma, call
an embedding model, or spend embedding tokens. Repeating the call reuses the
local evidence. If `CURRICULUM_SEMANTIC_FALLBACK=true`, the same tool also
builds the isolated Chroma collection `curriculum_documents` with the
configured embedding model. An optional semantic-index failure never deletes
the source or local evidence.

Call `retry_curriculum_extraction` separately to run course-table extraction,
deterministic validation, and model review. The tool reads only the
server-managed, hash-checked copy, so it no longer needs the original upload
path. Page-level evidence, candidate course rows, validation diagnostics, and
failed-page metadata are saved beside the source. A partial result uses
`extraction_status: "EXTRACTION_PARTIAL"`; a run with zero structured course
rows uses `extraction_status: "EXTRACTION_FAILED"`. No result is automatically
published to `data/course_catalog.json`.
`pages_attempted` lists pages included in model requests, while
`pages_skipped` lists pages skipped after the connection circuit opens.
When native PDF text exists but model conversion fails, the result also keeps
`course_line_candidates`: literal lines that begin with a course-code pattern,
including page number and raw text. These are explicitly unverified evidence,
not parsed course records; they are never passed to `course_path_plan` or
published to the shared catalog.

This separation prevents one AionUi tool call from waiting for file copying,
embedding, multi-page extraction, retries, and review all at once. A slow or
failed model stage can be retried without uploading or indexing the PDF again.

Use `get_curriculum_document` with a `document_id` to read a previously stored
interpretation in a later conversation. It returns candidate course rows,
validation/review status, and bounded `sources` containing the original file
name, page, chunk index, and source-text preview. It never returns a local path.

Use `curriculum_search` for later natural-language interpretation. Filters for
`major`, `cohort`, `version`, and `document_id` are optional but should be
provided whenever known. Results below the configured cosine-similarity
threshold are rejected and successful evidence is returned only through the
shared `sources` array with file name, page, chunk index, and score.

Search first ranks the already stored chunks locally with ASCII-word and
Chinese-bigram query coverage. Clear lexical matches return immediately with
`search_mode: "lexical"` and do not spend embedding tokens or require another
attachment. Remote DashScope query embeddings and Chroma cosine similarity are
disabled by default so a connectivity failure cannot hold the MCP call open.
Set `CURRICULUM_SEMANTIC_FALLBACK=true` locally to opt in; only then do queries
without a reliable local match use `search_mode: "semantic"`.

Search never parses a PDF or builds an index implicitly. If the selected
document has not completed `curriculum_index_document`, it immediately returns
`EVIDENCE_NOT_INDEXED` with that tool as the next action. This keeps every
search call bounded to small local JSON reads and deterministic ranking.

```json
{
  "query": "毕业总学分要求是多少？",
  "major": "computer-science",
  "cohort": "2026",
  "version": "2026.1",
  "top_k": 5
}
```

RAG is an interpretation and evidence-retrieval path. It does not approve
course prerequisites and cannot repair incorrect OCR text. `course_path_plan`
continues to use only a deterministically validated structured catalog.

Example request:

```json
{
  "attachment_path": "D:/CampusFiles/software-engineering-2026.pdf",
  "major": "software-engineering",
  "cohort": "2026",
  "version": "2026.1"
}
```

Recommended AionUi sequence:

1. Call `curriculum_ingest_from_attachment` once and keep its `document_id`.
2. Call `curriculum_index_document` with that ID; this enables
   `curriculum_search` in later conversations.
3. Call `retry_curriculum_extraction` with the same ID when structured course
   rules are needed for validation and planning.
4. Use `list_curriculum_documents` or `get_curriculum_document` to inspect
   status instead of uploading the same file again.

### Course graph, progress, and document-based prerequisite checks

`curriculum_graph(document_id)` returns nodes and prerequisite IDs only for a
complete, validated, auto-reviewed catalog. Incomplete OCR, unknown
prerequisites, or an unreviewed catalog return `CATALOG_NOT_READY`; the app
must not replace that error with the bundled demonstration data. The graph's
`total_credits` is `null` unless a verified graduation total is structured.

The academic-path page imports a PDF/image, then explicitly requests graph
generation. Graph generation may call `retry_curriculum_extraction` once and
take several minutes. The existing PDF is reused; no second upload is needed.

`course_path_plan` accepts optional `document_id`. When set, its deterministic
prerequisite check uses *only* the verified catalog attached to that document.
`major` and `grade` must match the catalog's major and cohort. Without
`document_id`, it retains the legacy bundled example catalog, which is not a
substitute for a student's uploaded plan.

If graph generation fails at `model_extract`, the AionUi page displays the
first genuinely attempted failed page and its redacted reason. Use
`curriculum_extraction_probe(document_id, page)` for an explicit, bounded
diagnostic of that stored **text PDF** page. It sends the page's native text
to the configured extraction model twice: one non-streaming request and one
streaming request, each requesting only a tiny JSON response. This may incur
model usage charges. It returns only mode outcomes, error codes/reasons and
timings—never source text, model output or credentials. It does not retry the
whole PDF, write a course catalog or prove that complete extraction will work.
For image-only pages it returns `PAGE_TEXT_UNAVAILABLE`.

Example for a verified uploaded document:

```json
{
  "document_id": "curriculum-computer-science-2026-example",
  "major": "computer-science",
  "grade": "2026",
  "completed_courses": ["CS101"],
  "target_course": "CS201"
}
```

`save_course_progress`, `load_course_progress`, and `clear_course_progress`
use an anonymous UUID and `document_id`; saved records contain only course
codes with `passed` or `failed` status. They live in `student_progress/`
(override with `COURSE_PATH_PROGRESS_DIR`), separate from public curriculum
documents, and are Git-ignored. `clear_course_progress` requires
`confirm: true`. The app's clear action also removes its local progress cache.
No name, student number, grade, or transcript is saved by these tools.
For a not-yet-verified PDF preview, save/load check course IDs against the
hash-checked stored source and the deterministic local course parser; this
permits personal status tracking without publishing or trusting prerequisite
rules. Course-eligibility planning still requires a verified catalog.

Use `list_curriculum_documents` with optional `major`, `cohort`, and `version`
filters to inspect the curriculum partition. `clear_curriculum_knowledge_base`
requires `confirm: true` and clears only files and candidate records inside
`curriculum_knowledge_base/`; it does not clear policy knowledge, alter the
original uploaded files, or modify `data/course_catalog.json`. Its response
includes `COURSE_CATALOG_MAY_BE_STALE` because an already published catalog may
need to be replaced after a curriculum change.

### AionUi MCP configuration

Each computer imports a local MCP configuration. `command`, `args`, and `cwd`
must point to that computer's Python and cloned project.

```json
{
  "mcpServers": {
    "course_path_server": {
      "command": "C:/path/to/python.exe",
      "args": ["D:/path/to/AionUi-Campus/course-path-server/server.py"],
      "cwd": "D:/path/to/AionUi-Campus/course-path-server",
      "env": {
        "CURRICULUM_KNOWLEDGE_BASE_DIR": "D:/path/to/curriculum-knowledge-base",
        "DASHSCOPE_API_KEY": "set-locally-never-commit",
        "EMBEDDING_MODEL": "text-embedding-v4",
        "CURRICULUM_SCORE_THRESHOLD": "0.3",
        "CURRICULUM_SEMANTIC_FALLBACK": "false"
      }
    }
  }
}
```

`CURRICULUM_KNOWLEDGE_BASE_DIR` is optional. When omitted, the server stores
shared curriculum data in `course-path-server/curriculum_knowledge_base/`.
Keep `DASHSCOPE_API_KEY` only in each computer's local MCP configuration or
process environment; never place an actual key in a committed JSON file.
`EMBEDDING_MODEL`, `CURRICULUM_SCORE_THRESHOLD`, and
`CURRICULUM_SEMANTIC_FALLBACK` are optional; their defaults are
`text-embedding-v4`, `0.3`, and `false`.

### Local model experiments

The committed defaults are `qwen3.8-flash` for structured visual extraction and
`qwen3.8-flash` for visual catalog review. A computer can temporarily override
either model in its local MCP JSON without changing `data/model_config.json`:

```json
"COURSE_PATH_REVIEW_MODEL": "qwen3.8-max"
```

If `retry_curriculum_extraction` fails after the source document is stored, its
response contains `data.extraction.ok: false` and a safe error summary. The summary may
include only a diagnostic code, the `ocr` or `review` stage, a schema reason,
row number, expected column names, an HTTP status, or one of the safe transport
reasons `timeout`, `dns_resolution_failed`, `tls_failed`, `connection_refused`,
or `connection_failed`. It never returns provider response text, attachment
contents, local paths, or credentials.

The extractor accepts strict TSV as its primary manual-import contract and also normalizes
common Chinese table headers, Markdown tables, and JSON arrays under `courses`,
`rows`, or `data`. Model-assisted attachment interpretation may retain a row
whose course code and name are readable while setting unreadable fields to
`null`; deterministic validation then marks the draft incomplete. Diagnostics
never include the provider response text.

Example request:

```json
{
  "attachment_path": "D:/CampusFiles/curriculum.pdf",
  "major": "software-engineering",
  "cohort": "2026",
  "version": "2026.1"
}
```

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

This phase defines and tests the safe decision boundary used by the DashScope
adapter. The adapter only uses a local environment variable at request time.

## Front-end v2 program-plan JSON preview

`parse_program_plan` accepts `filePath` (absolute path), optional `fileName`,
and optional `includeFlow` (default `false`).
It returns the front-end contract directly, without the older `ok/data/meta`
envelope. On success the JSON contains `success`, `major`, `grade`, `version`,
`totalCredits`, `courses`, and `warnings`; on failure it contains only
`success: false`, `errorCode`, and `errorMessage`.

The base fast path reads a text-layer PDF table locally. It does not call a
model, write a course catalog, or mark a plan verified. With `includeFlow=true`,
it renders only the page headed `课程体系配置流程图` and makes one bounded vision-model
request for directly visible course-to-course arrows. The page is rendered with
the Python `pypdfium2` dependency, without a separate system Poppler install.
When the section headings are readable, surrounding tables are cropped out.
The model transcribes endpoint labels; the server maps only uniquely matching
course names (ignoring spacing and core-course stars) and rejects arrows that
conflict with the table's semester order. Validated candidates are
returned in optional `recommendedSequences` as `{from, to, page}`; they are
**not** copied into `prerequisites` or used to decide enrollment eligibility.
If rendering or the model fails, the course-node preview still succeeds with an
empty sequence list and a warning. The graduation year must be
present in an already-ingested document record with the same SHA-256 or in the
file name; it is never guessed from the computer's clock. Rows lacking a
definite course name, credit value, semester 1-8, or required/elective marker
are skipped and counted in `warnings`. If the document does not state direct
prerequisites per course, `prerequisites` remains empty for this *display-only*
preview and a warning explicitly says it cannot be used to decide eligibility.
Scanned PDFs, Word documents, and standalone images still require a separate
OCR path and currently return a clear failure here.

The desktop's normal upload flow now stores the source and calls this preview
tool for the selected PDF. Only a validated catalog may enable the course
eligibility action; a preview keeps that action disabled. The older model-driven
catalog extraction remains available as a separate tool and is not silently
substituted for this preview.

## Known limitations

- The MVP checks prerequisite relationships and basic recommendations only.
- It does not create an optimal multi-semester schedule or complex What-if
  plans.
- PDF extraction is limited to five likely course-table pages in V0.1.
- Partial interpretations are queryable evidence, but they are not approved
  course-planning rules.
