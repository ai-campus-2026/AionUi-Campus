"""Input contracts for automated catalog-review decisions."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class CatalogReviewInput:
    """A draft catalog and optional structured findings from a model reviewer.

    ``model_review`` is intentionally structured. A future Qwen/OCR adapter
    must produce this contract; the publication decision never trusts prose.
    """

    catalog: dict[str, Any]
    model_review: dict[str, Any] | None = None

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "CatalogReviewInput":
        catalog = payload.get("catalog")
        if not isinstance(catalog, dict):
            raise _invalid_argument("catalog_must_be_object")
        model_review = payload.get("model_review")
        if model_review is not None and not isinstance(model_review, dict):
            raise _invalid_argument("model_review_must_be_object")
        return cls(catalog=catalog, model_review=model_review)


@dataclass(frozen=True)
class CatalogReviewError(Exception):
    """A recoverable malformed automated-review input error."""

    code: str
    message: str
    details: dict[str, Any]


def _invalid_argument(reason: str) -> CatalogReviewError:
    return CatalogReviewError(
        code="INVALID_ARGUMENT",
        message="课程目录复核参数错误",
        details={"reason": reason},
    )
