# Course catalog data

Each catalog represents exactly one major, student cohort, and curriculum
version. The runtime catalog must include the fields defined in
`schemas/catalog.py`.

Catalog status has three meanings:

- `mock`: development-only sample data; never use it for formal conclusions.
- `draft`: extracted or manually entered data awaiting validation and review.
- `verified`: reviewed data that may be used for formal course-planning output.

Future extraction workflows should create drafts first. They must not overwrite
an existing verified catalog.
