"""Validated inputs for curriculum semantic search."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class CurriculumSearchInput:
    """One bounded query against the shared curriculum document partition."""

    query: str
    major: str | None = None
    cohort: str | None = None
    version: str | None = None
    document_id: str | None = None
    top_k: int = 5

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "CurriculumSearchInput":
        query = _required_text(payload, "query")
        top_k = payload.get("top_k", 5)
        if isinstance(top_k, bool) or not isinstance(top_k, int) or not 1 <= top_k <= 20:
            raise CurriculumSearchInputError("top_k_must_be_integer_between_1_and_20")
        return cls(
            query=query,
            major=_optional_text(payload, "major"),
            cohort=_optional_text(payload, "cohort"),
            version=_optional_text(payload, "version"),
            document_id=_optional_text(payload, "document_id"),
            top_k=top_k,
        )


@dataclass(frozen=True)
class CurriculumIndexInput:
    """One explicit request to index an already managed curriculum source."""

    document_id: str
    force: bool = False

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "CurriculumIndexInput":
        force = payload.get("force", False)
        if not isinstance(force, bool):
            raise CurriculumSearchInputError("force_must_be_boolean")
        return cls(document_id=_required_text(payload, "document_id"), force=force)


class CurriculumSearchInputError(Exception):
    """A safe validation failure for an MCP search request."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.code = "INVALID_ARGUMENT"
        self.message = "培养方案检索参数错误"
        self.details = {"reason": reason}


def _required_text(payload: dict[str, Any], field: str) -> str:
    value = _optional_text(payload, field)
    if value is None:
        raise CurriculumSearchInputError(f"{field}_required")
    return value


def _optional_text(payload: dict[str, Any], field: str) -> str | None:
    value = payload.get(field)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise CurriculumSearchInputError(f"{field}_must_be_non_empty_string")
    return value.strip()
