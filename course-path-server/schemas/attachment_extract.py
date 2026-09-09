"""Input structures for model-assisted extraction from a local attachment."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class AttachmentExtractInput:
    """Metadata plus an already validated local attachment path."""

    attachment_path: str
    major: str
    cohort: str
    version: str
    catalog_id: str | None = None

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "AttachmentExtractInput":
        return cls(
            attachment_path=_required_text(payload, "attachment_path"),
            major=_required_text(payload, "major"),
            cohort=_required_text(payload, "cohort"),
            version=_required_text(payload, "version"),
            catalog_id=_optional_text(payload, "catalog_id"),
        )


@dataclass
class AttachmentExtractError(Exception):
    """A recoverable input or temporary-document processing error."""

    code: str
    message: str
    details: dict[str, Any]


def _required_text(payload: dict[str, Any], field: str) -> str:
    value = _optional_text(payload, field)
    if value is None:
        raise AttachmentExtractError("INVALID_ARGUMENT", "附件提取参数错误", {"reason": f"{field}_required"})
    return value


def _optional_text(payload: dict[str, Any], field: str) -> str | None:
    value = payload.get(field)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise AttachmentExtractError("INVALID_ARGUMENT", "附件提取参数错误", {"reason": f"{field}_must_be_non_empty_string"})
    return value.strip()
