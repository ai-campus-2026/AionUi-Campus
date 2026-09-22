"""Read-only validation for local attachments supplied to the MCP server."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any


ALLOWED_EXTENSIONS = frozenset({".pdf", ".png", ".jpg", ".jpeg"})
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024


def inspect_attachment(path_value: str | None) -> dict[str, Any] | None:
    """Return safe metadata for an optional local attachment without modifying it.

    Invalid attachments deliberately become warnings in course planning. The
    caller can still use supplied structured course data for the MVP.
    """
    if path_value is None:
        return None

    try:
        attachment = Path(_normalize_windows_path(path_value)).resolve(strict=True)
    except OSError:
        return _rejected("ATTACHMENT_NOT_FOUND")

    if not attachment.is_file():
        return _rejected("ATTACHMENT_NOT_A_FILE")
    if attachment.suffix.lower() not in ALLOWED_EXTENSIONS:
        return _rejected("ATTACHMENT_TYPE_UNSUPPORTED")

    try:
        size_bytes = attachment.stat().st_size
    except OSError:
        return _rejected("ATTACHMENT_NOT_READABLE")
    if size_bytes > MAX_ATTACHMENT_BYTES:
        return _rejected("ATTACHMENT_TOO_LARGE")

    try:
        digest = _sha256(attachment)
    except OSError:
        return _rejected("ATTACHMENT_NOT_READABLE")
    return {
        "status": "VALID",
        "extension": attachment.suffix.lower(),
        "size_bytes": size_bytes,
        "sha256": digest,
    }


def _normalize_windows_path(path_value: str) -> str:
    """Accept Windows verbatim paths while retaining exact-file-only access."""
    if path_value.startswith("\\\\?\\"):
        return path_value[4:]
    return path_value


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as attachment_file:
        while chunk := attachment_file.read(64 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _rejected(reason: str) -> dict[str, Any]:
    return {"status": "REJECTED", "reason": reason}
