"""配置管理模块"""

import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    """全局配置"""

    # DashScope API Key
    DASHSCOPE_API_KEY: str = os.getenv("DASHSCOPE_API_KEY", "")

    # Embedding 模型
    EMBEDDING_MODEL: str = os.getenv("EMBEDDING_MODEL", "text-embedding-v4")

    # ChromaDB 持久化目录
    CHROMA_PERSIST_DIR: str = os.getenv("CHROMA_PERSIST_DIR", "./chroma_data")

    # 文档分块参数（字符数，供 RecursiveCharacterTextSplitter 使用）
    CHUNK_SIZE: int = int(os.getenv("CHUNK_SIZE", "500"))
    CHUNK_OVERLAP: int = int(os.getenv("CHUNK_OVERLAP", "50"))

    # 检索参数
    # ------------------------------------------------------------------
    # 两阶段检索：先宽召回 RECALL_TOP_N 条候选，再由 rerank 精排，最终返回 TOP_K 条。
    # TOP_K: 精排后实际返回给 Agent 的文档块数量
    TOP_K: int = int(os.getenv("TOP_K", "5"))
    # RECALL_TOP_N: 粗召回窗口大小（须显著大于 TOP_K，否则精排没有意义）
    RECALL_TOP_N: int = int(os.getenv("RECALL_TOP_N", "20"))
    # SCORE_THRESHOLD: 粗召回阶段的余弦相似度下限。
    # 仅作「明显无关」的宽松粗筛，真正的质量过滤交给 RERANK_THRESHOLD ——
    # text-embedding-v4 对中文政策文本区分度差（不相关内容也常有 0.4~0.6 余弦），
    # 阈值卡太高会误杀正确答案。
    SCORE_THRESHOLD: float = float(os.getenv("SCORE_THRESHOLD", "0.1"))
    # RERANK_THRESHOLD: 精排分数下限，低于该值的块不返回（rerank 降级时不生效）。
    #
    # 标定依据（真实知识库 44 块：综测细则 docx + 推免细则 pdf，非孤立短句测试）：
    #   应拒识问题（奖学金/转专业/重邮〔2024〕15号/食堂开门）rerank 最高分 = 0.1943
    #   应命中问题（综测/推免/创新创业加分）rerank 最低通过分       = 0.3076
    #   -> 真实分离间隙为 [0.1943, 0.3076]，取中点 0.25，两侧余量各约 0.056。
    # 注意：真实 500 字符块中相关内容会被稀释，分数显著低于孤立短句测试值
    # （孤立测试曾观测到 0.78），因此阈值必须用真实块分布定标，不可凭短句实验值。
    RERANK_THRESHOLD: float = float(os.getenv("RERANK_THRESHOLD", "0.25"))

    # 重排序（精排）模型
    # ------------------------------------------------------------------
    # gte-rerank-v2: 分离度干净，不相关块集中在 0.006~0.19，适合阈值过滤（当前默认）
    # qwen3-rerank : 绝对分更高但底部噪声大（不相关也有 0.30），阈值难切
    # gte-rerank(v1): 已下线，调用返回 403 Access Denied，勿用
    RERANK_MODEL: str = os.getenv("RERANK_MODEL", "gte-rerank-v2")
    RERANK_ENABLED: bool = os.getenv("RERANK_ENABLED", "true").lower() not in ("0", "false", "no")
    # rerank 单次请求文档数上限（gte-rerank-v2 官方上限 500）
    RERANK_MAX_DOCS: int = int(os.getenv("RERANK_MAX_DOCS", "500"))
    RERANK_MAX_RETRIES: int = int(os.getenv("RERANK_MAX_RETRIES", "2"))
    RERANK_TIMEOUT: int = int(os.getenv("RERANK_TIMEOUT", "30"))

    # 混合召回（BM25 关键词 + 向量语义，RRF 融合）
    # ------------------------------------------------------------------
    # BM25 补足向量检索对精确 token 的天然弱势：文号（重邮〔2024〕15号）、
    # 条款号（第五条）、学院专名、数字阈值（425分）等。
    BM25_ENABLED: bool = os.getenv("BM25_ENABLED", "true").lower() not in ("0", "false", "no")
    # RRF 平滑常数，经验值 60（值越大，排名靠前的结果优势越弱）
    RRF_K: int = int(os.getenv("RRF_K", "60"))

    # DashScope text-embedding-v4 单次请求条数上限
    EMBED_BATCH_SIZE: int = int(os.getenv("EMBED_BATCH_SIZE", "10"))

    # Embedding API 失败重试次数
    EMBED_MAX_RETRIES: int = int(os.getenv("EMBED_MAX_RETRIES", "3"))

    # 日志级别（日志一律写 stderr，不污染 stdio 协议流）
    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")
