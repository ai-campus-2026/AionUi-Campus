"""Shared response-envelope helpers for the course-path MCP server."""

from __future__ import annotations

from typing import Any, Mapping


SCHEMA_VERSION = "0.1"


def success_response(
    data: Mapping[str, Any],
    *,
    sources: list[dict[str, Any]] | None = None,
    warnings: list[str] | None = None,
    meta: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a successful response using the team Schema V0.1 envelope."""
    return {
        "schema_version": SCHEMA_VERSION,
        "ok": True,
        "data": dict(data),
        "sources": sources or [],
        "warnings": warnings or [],
        "error": None,
        "meta": dict(meta or {}),
    }


def error_response(
    code: str,
    message: str,
    *,
    details: Mapping[str, Any] | None = None,
    sources: list[dict[str, Any]] | None = None,
    warnings: list[str] | None = None,
    meta: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a failed response using the team Schema V0.1 envelope."""
    return {
        "schema_version": SCHEMA_VERSION,
        "ok": False,
        "data": None,
        "sources": sources or [],
        "warnings": warnings or [],
        "error": {
            "code": code,
            "message": message,
            "details": dict(details or {}),
        },
        "meta": dict(meta or {}),
    }
