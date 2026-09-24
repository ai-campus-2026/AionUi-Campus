"""Regression coverage for anonymous course progress persistence."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

import server
from tools.curriculum_store import CurriculumStoreError


def _catalog_not_ready(_document_id: str) -> None:
    raise CurriculumStoreError("CATALOG_NOT_READY", "catalog is not ready")


def test_unknown_stored_cohort_uses_unknown_preview_grade(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, str] = {}

    def parse_preview(_pages: list[str], *, grade: str, version: str | None = None) -> dict[str, object]:
        captured["grade"] = grade
        return {"courses": [{"id": "A2040030"}]}

    monkeypatch.setattr(server, "_verified_curriculum_catalog", _catalog_not_ready)
    monkeypatch.setattr(
        server,
        "curriculum_store",
        SimpleNamespace(
            load_source_for_retry=lambda _document_id: (
                {"cohort": "unspecified", "version": "auto"},
                Path("curriculum.pdf"),
                None,
            )
        ),
    )
    monkeypatch.setattr(server, "native_pdf_pages_for_plan", lambda _source: ["preview"])
    monkeypatch.setattr(server, "parse_program_plan_pages", parse_preview)

    assert server._progress_known_course_codes("document-1") == {"A2040030"}
    assert captured["grade"] == ""


def test_four_digit_stored_cohort_is_preserved_for_preview(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, str] = {}

    def parse_preview(_pages: list[str], *, grade: str, version: str | None = None) -> dict[str, object]:
        captured["grade"] = grade
        return {"courses": [{"id": "A2040030"}]}

    monkeypatch.setattr(server, "_verified_curriculum_catalog", _catalog_not_ready)
    monkeypatch.setattr(
        server,
        "curriculum_store",
        SimpleNamespace(
            load_source_for_retry=lambda _document_id: (
                {"cohort": "2026", "version": "2026.1"},
                Path("curriculum.pdf"),
                None,
            )
        ),
    )
    monkeypatch.setattr(server, "native_pdf_pages_for_plan", lambda _source: ["preview"])
    monkeypatch.setattr(server, "parse_program_plan_pages", parse_preview)

    assert server._progress_known_course_codes("document-1") == {"A2040030"}
    assert captured["grade"] == "2026"
