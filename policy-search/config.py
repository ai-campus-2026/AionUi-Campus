"""配置管理模块"""

import os
import sys
from pathlib import Path

from dotenv import load_dotenv

# 模块根目录（始终解析为绝对路径，避免 MCP Server 被外部启动时 CWD 不对）
_MODULE_DIR = Path(__file__).resolve().parent


def _ensure_env_file() -> Path:
    """首次启动自愈：.env 不存在时从 .env.example 自动生成一份。

    .env 被 .gitignore 忽略，换电脑 git clone 后不会带过来；这里自动补一份
    只含占位符/相对路径默认值的模板。真实 Key 由应用侧注入宿主环境变量
    （override=False 保证注入值优先），无需手工填写。占位符替换为空串，
    避免被当成真 Key 发出去。
    """
    env_file = _MODULE_DIR / ".env"
    if not env_file.exists():
        example_file = _MODULE_DIR / ".env.example"
        if example_file.exists():
            try:
                content = (
                    example_file.read_text(encoding="utf-8")
                    .replace("your_api_key_here", "")
                    .replace("your_dashscope_api_key", "")
                )
                env_file.write_text(content, encoding="utf-8")
                print(
                    f"[config] {env_file.name} not found, generated from .env.example "
                    "(real key is injected by the app)",
                    file=sys.stderr,
                )
            except OSError:
                pass
    return env_file


# 显式按本文件所在目录定位 .env：stdio MCP 服务由宿主进程拉起，工作目录不可靠
load_dotenv(_ensure_env_file())


class Config:
    """全局配置"""

    # DashScope API Key
    DASHSCOPE_API_KEY: str = os.getenv("DASHSCOPE_API_KEY", "")

    # LLM 模型
    LLM_MODEL: str = os.getenv("LLM_MODEL", "qwen3.7-plus")

    # Embedding 模型
    EMBEDDING_MODEL: str = os.getenv("EMBEDDING_MODEL", "text-embedding-v4")

    # 知识库根目录（相对路径一律按模块目录解析为绝对路径，避免 CWD 不对时找不到库）
    _KB_DIR_RAW: str = os.getenv("KNOWLEDGE_BASE_DIR") or "knowledge_base"
    KNOWLEDGE_BASE_DIR: str = str((_MODULE_DIR / _KB_DIR_RAW).resolve())

    # 文档分块参数（用于长文档解析）
    CHUNK_SIZE: int = int(os.getenv("CHUNK_SIZE", "2000"))
    CHUNK_OVERLAP: int = int(os.getenv("CHUNK_OVERLAP", "200"))

    # 分类标识
    CATEGORIES = {
        "postgraduate_recommendation": "保研/推免",
        "scholarship": "奖学金",
        "financial_aid": "助学金/资助",
        "academic": "学业管理",
        "discipline": "纪律处分",
        "exchange": "交流交换",
        "employment": "就业创业",
        "other": "其他",
    }

    # 条件类型
    CONDITION_TYPES = {
        "hard": "硬性门槛",
        "scoring": "评分项",
        "ranking": "排名项",
        "bonus": "加分项",
        "preference": "优先条件",
        "procedural": "流程性要求",
        "qualitative": "模糊定性条件",
    }

    # 要求分类（用于结构化存储）
    REQUIREMENT_CATEGORIES = {
        "gpa": "绩点/成绩要求",
        "foreign_language": "外语要求",
        "academic": "学业表现要求",
        "disciplinary": "纪律/品行要求",
        "research": "科研/论文要求",
        "competition": "竞赛/获奖要求",
        "bonus": "加分项",
        "procedural": "流程性要求",
        "health": "健康要求",
        "other": "其他要求",
    }

    # ============================================================
    # 清单展示契约（前端渲染用）—— 每条 condition 会被打上下面两个字段
    # ============================================================

    # board: 条件所属板块（前端分组键）。四选一。
    CHECKLIST_BOARDS = {
        "veto": "一票否决",   # 命中即不合格，短路判定，前端做顶部小确认条
        "base": "基础门槛",   # 必须满足的硬性条件（绩点/外语/身份/待提交材料）
        "bonus": "加分项",    # 竞赛/科研/荣誉等，用于算综合分
        "other": "其他须知",  # 不可量化的宣誓/品行/义务/健康声明，仅折叠展示，不勾选
    }

    # input_kind: 前端渲染控件类型。与 board 正交。
    INPUT_KINDS = {
        "yes_no": "是/否开关",
        "number": "数字输入",
        "range": "区间/分数段选择",
        "select": "下拉单选",
        "upload": "上传佐证",
        "text": "文本填写",
        "none": "纯展示无控件",
    }
