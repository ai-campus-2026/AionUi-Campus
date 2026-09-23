"""MCP Server — 基于 mcp SDK 的 FastMCP 实现。"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
import uuid
from pathlib import Path

from dotenv import load_dotenv

# 确保项目根目录在 sys.path 中
_project_root = Path(__file__).parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

# 加载 .env 文件（如果存在）
_env_file = _project_root / ".env"
if _env_file.exists():
    load_dotenv(_env_file)
else:
    # 尝试从 .env.example 复制一份（仅用于提示）
    _example_file = _project_root / ".env.example"
    if _example_file.exists():
        print(
            "⚠️  警告: 未找到 .env 文件，请复制 .env.example 为 .env 并填入 API Key。",
            file=sys.stderr,
        )

# 日志只写 stderr
logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger("contract_scan_mcp")

from mcp.server.fastmcp import FastMCP

from engine.merger import scan_contract

mcp = FastMCP("contract-scan")


@mcp.tool()
def contract_scan(
    contract_text: str,
    contract_type: str = "unknown",
    city_min_wage: float = 0,
    skip_llm: bool = False,
    api_key: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
) -> str:
    """合同风险扫描工具 — 面向中国大学生和应届毕业生。支持租房合同、实习协议、劳动合同、保密协议的风险扫描，结合正则硬规则（中国法规）和 LLM 智能分析，输出结构化 JSON 报告。

    Args:
        contract_text: 合同全文（纯文本）
        contract_type: 合同类型，可选 rental/internship/employment/nda/unknown
        city_min_wage: 所在城市最低工资（元），用于竞业补偿等规则校验
        skip_llm: 是否跳过 LLM 分析（仅运行正则规则检查），默认 False 启用 LLM
        api_key: DashScope API key（如 DASHSCOPE_API_KEY 已配置在环境变量则无需传入）
        base_url: API 基础 URL（默认 https://dashscope.aliyuncs.com/compatible-mode/v1）
        model: LLM 模型名（默认 qwen-plus）
    """
    start_time = time.time()
    request_id = str(uuid.uuid4())[:8]

    if len(contract_text.strip()) < 50:
        return json.dumps({
            "ok": False,
            "data": {},
            "sources": [],
            "warnings": ["合同文本过短（少于50字符），无法进行有效分析"],
            "meta": {"request_id": request_id, "tool": "contract_scan"},
        }, ensure_ascii=False, indent=2)

    try:
        result = scan_contract(
            contract_text=contract_text,
            contract_type=contract_type,
            lang="zh",
            skip_llm=skip_llm,
            api_key=api_key,
            base_url=base_url,
            model=model,
        )

        elapsed_ms = int((time.time() - start_time) * 1000)

        return json.dumps({
            "ok": True,
            "data": result,
            "sources": result.get("sources", []),
            "warnings": [],
            "meta": {
                "request_id": request_id,
                "tool": "contract_scan",
                "elapsed_ms": elapsed_ms,
            },
        }, ensure_ascii=False, indent=2)

    except ValueError as e:
        return json.dumps({
            "ok": False,
            "data": {},
            "sources": [],
            "warnings": [str(e)],
            "meta": {"request_id": request_id, "tool": "contract_scan"},
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return json.dumps({
            "ok": False,
            "data": {},
            "sources": [],
            "warnings": [f"内部错误: {type(e).__name__}: {e}"],
            "meta": {"request_id": request_id, "tool": "contract_scan"},
        }, ensure_ascii=False, indent=2)


def main() -> None:
    logger.info("Contract Scan MCP Server 启动 (stdio)")
    mcp.run()  # 默认 stdio transport


if __name__ == "__main__":
    main()
