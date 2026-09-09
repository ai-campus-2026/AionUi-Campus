"""Ephemeral PDF/image curriculum extraction through the DashScope adapters."""

from __future__ import annotations

import base64
import shutil
import subprocess
import tempfile
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

from tools.dashscope_client import DashScopeClient, DashScopeConfig, DashScopeError
from schemas.attachment_extract import AttachmentExtractError, AttachmentExtractInput
from schemas.catalog_review import CatalogReviewError, CatalogReviewInput
from schemas.curriculum_extract import CurriculumExtractError
from schemas.curriculum_extract import CurriculumExtractInput
from tools.attachment_validation import inspect_attachment
from tools.catalog_review import review_catalog
from tools.catalog_validate import validate_catalog
from tools.curriculum_extract import extract_catalog_draft


CONFIG_PATH = Path(__file__).resolve().parents[1] / "data" / "model_config.json"
MAX_BASE64_SOURCE_BYTES = 7 * 1024 * 1024
TEMP_ROOT = Path(tempfile.gettempdir()) / "course-path-server"
TEMP_RETENTION = timedelta(hours=24)


def extract_catalog_from_attachment(input_data: AttachmentExtractInput) -> dict[str, Any]:
    """Extract and review one attachment without saving attachment or student data."""
    inspection = inspect_attachment(input_data.attachment_path)
    if inspection is None or inspection["status"] != "VALID":
        reason = "ATTACHMENT_REQUIRED" if inspection is None else inspection["reason"]
        raise AttachmentExtractError("INVALID_ARGUMENT", "附件不可用于提取", {"reason": reason})

    attachment = Path(input_data.attachment_path).resolve(strict=True)
    try:
        cleanup_stale_temporary_workspaces()
        config = DashScopeConfig.from_file(CONFIG_PATH)
        with _visual_inputs(attachment, config.max_pdf_pages) as images:
            client = DashScopeClient(config)
            table_tsv = client.extract_tsv(images)
            catalog = extract_catalog_draft(
                CurriculumExtractInput(
                    document=attachment.name,
                    major=input_data.major,
                    cohort=input_data.cohort,
                    version=input_data.version,
                    course_table_tsv=_strip_tsv_fence(table_tsv),
                    catalog_id=input_data.catalog_id,
                )
            )
            validation = validate_catalog(catalog)
            model_review = client.review_catalog(images, catalog)
            review = review_catalog(CatalogReviewInput(catalog=catalog, model_review=model_review))
    except DashScopeError as error:
        raise AttachmentExtractError(error.code, error.message, error.details) from error
    except CurriculumExtractError as error:
        raise AttachmentExtractError(error.code, error.message, error.details) from error
    except CatalogReviewError as error:
        raise AttachmentExtractError("MODEL_RESPONSE_INVALID", "模型复核结果格式无效", {}) from error
    except subprocess.CalledProcessError as error:
        raise AttachmentExtractError("DOCUMENT_RENDER_FAILED", "PDF 页面转换失败", {"status": error.returncode}) from error

    return {
        "catalog": review["catalog"],
        "validation": validation,
        "review": review,
        "attachment": inspection,
    }


@contextmanager
def _visual_inputs(attachment: Path, max_pdf_pages: int) -> Iterator[list[dict[str, Any]]]:
    if attachment.suffix.lower() == ".pdf":
        TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="course-path-pdf-", dir=TEMP_ROOT) as temp_directory:
            output_prefix = Path(temp_directory) / "page"
            try:
                subprocess.run(
                    [
                        "pdftoppm",
                        "-png",
                        "-scale-to",
                        "2048",
                        "-f",
                        "1",
                        "-l",
                        str(max_pdf_pages),
                        str(attachment),
                        str(output_prefix),
                    ],
                    check=True,
                    capture_output=True,
                )
            except FileNotFoundError as error:
                raise AttachmentExtractError("DOCUMENT_RENDERER_UNAVAILABLE", "PDF 转换组件不可用", {}) from error
            pages = sorted(Path(temp_directory).glob("page-*.png"))
            if not pages:
                raise AttachmentExtractError("DOCUMENT_RENDER_FAILED", "PDF 未生成可识别页面", {})
            yield [_image_content(page) for page in pages]
        return
    yield [_image_content(attachment)]


def cleanup_stale_temporary_workspaces(
    *,
    temporary_root: Path = TEMP_ROOT,
    now: datetime | None = None,
) -> None:
    """Remove only this server's expired PDF-render workspaces."""
    if not temporary_root.exists():
        return
    current_time = now or datetime.now(timezone.utc)
    for workspace in temporary_root.glob("course-path-pdf-*"):
        if not workspace.is_dir():
            continue
        modified_at = datetime.fromtimestamp(workspace.stat().st_mtime, tz=timezone.utc)
        if current_time - modified_at > TEMP_RETENTION:
            shutil.rmtree(workspace, ignore_errors=True)


def _image_content(path: Path) -> dict[str, Any]:
    media_type = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}.get(path.suffix.lower())
    if media_type is None:
        raise AttachmentExtractError("INVALID_ARGUMENT", "附件类型不支持", {})
    if path.stat().st_size > MAX_BASE64_SOURCE_BYTES:
        raise AttachmentExtractError("MODEL_INPUT_TOO_LARGE", "模型图像输入过大", {})
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return {"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{encoded}"}}


def _strip_tsv_fence(text: str) -> str:
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped
    lines = stripped.splitlines()
    if len(lines) >= 3 and lines[-1].strip() == "```":
        return "\n".join(lines[1:-1]).strip()
    return stripped
