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
# （可能被置为任意路径），绝不能用相对路径找配置。
# override=False：宿主注入的环境变量（如 DASHSCOPE_API_KEY）优先于 .env 兜底。
load_dotenv(_ensure_env_file())


def _env_bool(name: str, default: bool) -> bool:
    """读取布尔型环境变量（1/true/yes/on 为真，不区分大小写）"""
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


class Config:
    """全局配置"""

    # DashScope API Key
    DASHSCOPE_API_KEY: str = os.getenv("DASHSCOPE_API_KEY", "")

    # Embedding 模型
    EMBEDDING_MODEL: str = os.getenv("EMBEDDING_MODEL", "text-embedding-v4")

    # ChromaDB 持久化目录：相对路径一律按模块目录解析为绝对路径。
    # 宿主进程 CWD 不可靠，旧行为按 CWD 解析会在随意目录下生成空库，
    # 造成「换了启动方式就查不到数据」的假故障；路径统一后生产库固定为
    # rag-mcp-server/chroma_data。
    CHROMA_PERSIST_DIR: str = str((_MODULE_DIR / os.getenv("CHROMA_PERSIST_DIR") or "./chroma_data").resolve())

    # 文档分块参数（字符数，供 RecursiveCharacterTextSplitter 使用）
    CHUNK_SIZE: int = int(os.getenv("CHUNK_SIZE", "500"))
    CHUNK_OVERLAP: int = int(os.getenv("CHUNK_OVERLAP", "50"))

    # —— 检索参数（两阶段：混合召回 + 重排序精排）——
    # TOP_K: 精排后实际返回给 Agent 的文档块数量
    TOP_K: int = int(os.getenv("TOP_K", "3"))
    # RECALL_TOP_N: 粗召回窗口大小（须显著大于 TOP_K，否则精排没有意义）
    RECALL_TOP_N: int = int(os.getenv("RECALL_TOP_N", "20"))
    # SCORE_THRESHOLD: 粗召回阶段的余弦下限（宽松粗筛「明显无关」）；
    # rerank 降级（不可调用）时也用它作为过滤阈值
    SCORE_THRESHOLD: float = float(os.getenv("SCORE_THRESHOLD", "0.3"))

    # DashScope text-embedding-v4 单次请求条数上限
    EMBED_BATCH_SIZE: int = int(os.getenv("EMBED_BATCH_SIZE", "10"))

    # Embedding API 失败重试次数
    EMBED_MAX_RETRIES: int = int(os.getenv("EMBED_MAX_RETRIES", "3"))

    # —— 重排序精排（DashScope TextReRank）——
    RERANK_ENABLED: bool = _env_bool("RERANK_ENABLED", True)
    # gte-rerank-v2: 分离度干净、适合阈值过滤（qwen3-rerank 底部噪声大）
    RERANK_MODEL: str = os.getenv("RERANK_MODEL", "gte-rerank-v2")
    # 精排分数下限，低于该值不返回（按真实知识库实测标定，见 .env 注释）
    RERANK_THRESHOLD: float = float(os.getenv("RERANK_THRESHOLD", "0.25"))
    # 单次送入精排的最大文档数（防超长请求）
    RERANK_MAX_DOCS: int = int(os.getenv("RERANK_MAX_DOCS", "500"))
    # 精排调用失败重试次数（总尝试次数）
    RERANK_MAX_RETRIES: int = int(os.getenv("RERANK_MAX_RETRIES", "2"))
    # HTTP 读超时（秒）。SDK 默认 300 秒过长；实现须以 request_timeout 传给
    # SDK（用 timeout 会被塞进请求体被服务端忽略，形成"假超时"）
    RERANK_TIMEOUT: int = int(os.getenv("RERANK_TIMEOUT", "30"))

    # —— BM25 关键词召回（补足文号/条款号/数字阈值等精确 token）——
    BM25_ENABLED: bool = _env_bool("BM25_ENABLED", True)
    # RRF 融合平滑常数，经验值 60
    RRF_K: int = int(os.getenv("RRF_K", "60"))

    # 日志级别（日志一律写 stderr，不污染 stdio 协议流）
    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")
