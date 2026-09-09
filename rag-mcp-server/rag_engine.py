"""RAG 核心引擎 - 文档加载、分块、向量化、两阶段检索

设计要点:
- chunk ID 基于内容哈希 + upsert，重复/更新的文档不会静默丢失
- 页码元数据贯穿始终（pymupdf4llm page_chunks，1-based；非 PDF 格式无页码）
- **两阶段检索**：宽召回（向量 + BM25 经 RRF 融合）-> rerank 精排 -> 阈值过滤。
  纯向量余弦对中文政策文本区分度差（不相关内容也常有 0.4~0.6），单阶段检索
  既会误杀正确答案、又会放进语义相近但实际无关的块。
- **降级必须显式**：rerank / BM25 失败时回退并在响应中标注
  rerank_applied=false 与原因，绝不静默返回低质量结果
- 文档路径统一归一化（normcase+normpath），避免 Windows 大小写/分隔符差异
  导致同一文档重复入库或删除失效
- 日志只写 stderr，绝不碰 stdout（stdio MCP 协议通道）
"""

import hashlib
import json
import logging
import math
import os
import threading
import time
from typing import Any

import chromadb
import pymupdf4llm
from chromadb.config import Settings
from langchain_text_splitters import RecursiveCharacterTextSplitter

from config import Config
from hybrid_recall import BM25Index, rrf_fuse
from rerank_client import outcome_to_meta, rerank_documents

logger = logging.getLogger("rag_engine")

# 中文感知的分块分隔符，按优先级递减
_SEPARATORS = ["\n\n", "\n", "。", "！", "？", "；", "，", " ", ""]

# 支持的文档格式
SUPPORTED_EXTENSIONS = frozenset({".pdf", ".txt", ".md", ".markdown", ".docx"})


class RAGEngine:
    """RAG 引擎：文档加载、分块、向量化与检索（不含 LLM 生成）"""

    COLLECTION_NAME = "documents"

    def __init__(self):
        """初始化 ChromaDB 客户端、分块器与写入锁"""
        self.chroma_client = chromadb.PersistentClient(
            path=Config.CHROMA_PERSIST_DIR, settings=Settings(anonymized_telemetry=False)
        )
        self.collection = self.chroma_client.get_or_create_collection(
            name=self.COLLECTION_NAME,
            metadata={"hnsw:space": "cosine", "embedding_model": Config.EMBEDDING_MODEL},
        )

        # 若知识库是用其他 embedding 模型构建的，检索维度会不匹配，尽早报错
        stored_model = (self.collection.metadata or {}).get("embedding_model")
        if stored_model and stored_model != Config.EMBEDDING_MODEL:
            raise RuntimeError(
                f"知识库由 embedding 模型 {stored_model!r} 构建，当前配置为 "
                f"{Config.EMBEDDING_MODEL!r}，向量维度可能不匹配。"
                f"请清空知识库（clear_knowledge_base）或改回原模型。"
            )

        self._splitter = RecursiveCharacterTextSplitter(
            chunk_size=Config.CHUNK_SIZE,
            chunk_overlap=Config.CHUNK_OVERLAP,
            separators=_SEPARATORS,
        )
        # Chroma 写操作互斥（工具经 asyncio.to_thread 在线程池并发执行）
        self._write_lock = threading.Lock()

        # BM25 索引（带版本缓存，任何知识库写入后需 bump_version 失效）
        self._bm25 = BM25Index()

        logger.info(
            "RAGEngine 初始化完成，当前文档块数量: %d (rerank=%s/%s, bm25=%s)",
            self.collection.count(),
            "启用" if Config.RERANK_ENABLED else "关闭",
            Config.RERANK_MODEL,
            "启用" if Config.BM25_ENABLED else "关闭",
        )

    # ------------------------------------------------------------------ #
    # 文档加载
    # ------------------------------------------------------------------ #

    def load_document(self, file_path: str) -> str:
        """加载文档（PDF/TXT/MD/DOCX）：解析 -> 分块 -> 向量化 -> upsert 入库

        同一路径同一内容: 跳过（提示未变化）；同一路径内容有更新: 先删旧块再入库。
        """
        if not file_path or not file_path.strip():
            return "错误: file_path 不能为空"
        path = _normalize_source(file_path)
        if not _has_supported_extension(path):
            supported = "、".join(sorted(SUPPORTED_EXTENSIONS))
            return f"错误: 不支持的文件格式 - {path}（支持: {supported}）"

        file_hash = _sha256_file(path)
        logger.info("开始加载文档: %s (sha256=%s)", path, file_hash[:12])

        with self._write_lock:
            existing = self._chunks_of_source(path)
            if existing:
                unchanged = all(m.get("doc_id") == file_hash for m, _ in existing)
                if unchanged:
                    logger.info("文档未变化，跳过: %s", path)
                    return (
                        f"文档已存在于知识库且内容未变化，共 {len(existing)} 个文档块，"
                        f"本次跳过: {_display_name(path)}"
                    )
                # 内容有更新: 删除旧版本全部块（含历史路径写法不同的残留版本）
                self._delete_by_source(path)
                logger.info("检测到文档更新，已删除旧版本 %d 个块", len(existing))

            n_chunks = self._ingest(path, file_hash)

        return (
            f"成功加载文档: {_display_name(path)}，共 {n_chunks} 个文档块，"
            f"知识库当前总计 {self.collection.count()} 个块"
        )

    def _ingest(self, path: str, file_hash: str) -> int:
        """解析文档、逐页分块、批量向量化并 upsert。调用方需持有 _write_lock。"""
        ids: list[str] = []
        embeddings: list[list[float]] = []
        metadatas: list[dict[str, Any]] = []
        documents: list[str] = []

        for page_no, page_text in _extract_pages(path):
            if not page_text:
                continue
            for idx, chunk in enumerate(self._splitter.split_text(page_text)):
                chunk = chunk.strip()
                if not chunk:
                    continue
                ids.append(_chunk_id(path, file_hash, chunk))
                metadata = {"source": path, "doc_id": file_hash, "chunk_index": idx}
                if page_no is not None:  # ChromaDB 元数据不支持 null，无页码格式直接省略
                    metadata["page"] = page_no
                metadatas.append(metadata)
                documents.append(chunk)

        if not documents:
            raise ValueError(
                f"无法从文档提取到文本: {_display_name(path)}（PDF 可能是扫描件，或文档为空）"
            )

        # 分批向量化（text-embedding-v4 单次最多 10 条）
        for i in range(0, len(documents), Config.EMBED_BATCH_SIZE):
            batch = documents[i : i + Config.EMBED_BATCH_SIZE]
            embeddings.extend(_embed_batch(batch))

        self.collection.upsert(ids=ids, embeddings=embeddings, metadatas=metadatas, documents=documents)
        # 知识库已变更，BM25 索引缓存必须失效，否则新文档召回不到
        self._bm25.bump_version()
        logger.info("入库完成: %s, %d 个块", _display_name(path), len(documents))
        return len(documents)

    # ------------------------------------------------------------------ #
    # 检索
    # ------------------------------------------------------------------ #

    def search(self, question: str, top_k: int | None = None) -> dict[str, Any]:
        """两阶段检索：宽召回（向量 + BM25 经 RRF 融合）-> rerank 精排 -> 阈值过滤

        流程:
        1. 粗召回: 向量检索取 RECALL_TOP_N 条候选（余弦低于 SCORE_THRESHOLD 的
           宽松粗筛掉）；BM25 关键词检索独立召回一路；两路经 RRF 融合去重。
        2. 精排: 调用 gte-rerank-v2 对候选按真实相关性重新打分排序。
           rerank 失败时**显式降级**为融合排序，并在响应中标注。
        3. 过滤: 按 RERANK_THRESHOLD 过滤（降级时回退用 SCORE_THRESHOLD），
           取前 top_k 条返回。

        返回 dict 含 results（每项: text/source/page/rerank_score/vector_similarity/
        chunk_index）、count、rerank_applied，以及降级时的 rerank_error/rerank_hint。
        全被过滤时附 best_score 与 hint，帮调用方区分「不相关」与「库为空」。
        """
        question = (question or "").strip()
        if not question:
            return {"results": [], "count": 0, "error": "问题不能为空"}
        total = self.collection.count()
        if total == 0:
            return {"results": [], "count": 0, "error": "知识库为空，请先使用 load_document 加载文档"}

        final_k = max(1, min(top_k or Config.TOP_K, 20))
        # 召回窗口：至少 RECALL_TOP_N 且为最终条数的 4 倍，保证精排有筛选空间；
        # 上限受知识库总量约束。注意不可把 total 并入 max —— 否则小知识库会把
        # 全库都送去 rerank，白耗 token 与延迟，也违背 RECALL_TOP_N 的配置意图。
        recall_n = min(total, max(Config.RECALL_TOP_N, final_k * 4))

        # ---------------- 阶段 1: 粗召回 ----------------
        candidates = self._recall(question, recall_n)
        bm25_degraded = candidates["bm25_error"]
        if not candidates["items"]:
            payload: dict[str, Any] = {
                "results": [],
                "count": 0,
                "error": None,
                # 召回阶段就失败，rerank 自然没有执行
                "rerank_applied": False,
                "rerank_model": Config.RERANK_MODEL,
                "hint": f"向量与 BM25 召回均无候选（余弦粗筛阈值 {Config.SCORE_THRESHOLD}）。"
                "知识库中可能没有与该问题相关的内容。",
            }
            if bm25_degraded:
                payload["bm25_error"] = bm25_degraded
            return payload

        items = candidates["items"]
        logger.info(
            "粗召回完成: %d 个候选（向量 %d + BM25 %s）",
            len(items),
            candidates["vector_hits"],
            "关闭/降级" if bm25_degraded else f"{candidates['bm25_hits']}",
        )

        # ---------------- 阶段 2: rerank 精排 ----------------
        outcome = rerank_documents(question, [it["text"] for it in items], top_n=len(items))
        rerank_meta = outcome_to_meta(outcome)
        if bm25_degraded and "rerank_error" not in rerank_meta:
            rerank_meta["bm25_error"] = bm25_degraded

        if outcome.applied:
            for it in items:
                it["rerank_score"] = outcome.scores[it["_pos"]]
            # 按精排分数降序（None 防御性排后）
            items.sort(key=lambda x: (x["rerank_score"] is None, -(x["rerank_score"] or 0.0)))
            threshold = Config.RERANK_THRESHOLD
            score_key = "rerank_score"
        else:
            # 降级: 维持 RRF 融合顺序（candidates 已按融合分排序），用余弦阈值过滤
            for it in items:
                it["rerank_score"] = None
            threshold = Config.SCORE_THRESHOLD
            score_key = "vector_similarity"

        # ---------------- 阶段 3: 阈值过滤 + 截断 ----------------
        kept: list[dict[str, Any]] = []
        all_scores: list[float] = []
        for it in items:
            score = it.get(score_key)
            if isinstance(score, (int, float)) and not math.isnan(score):
                all_scores.append(float(score))
            if score is None or score < threshold:
                continue
            kept.append(
                {
                    "text": it["text"],
                    "source": it["metadata"].get("source", ""),
                    "page": it["metadata"].get("page"),
                    "rerank_score": it["rerank_score"],
                    "vector_similarity": it["vector_similarity"],
                    "chunk_index": it["metadata"].get("chunk_index"),
                }
            )

        kept = kept[:final_k]
        payload = {"results": kept, "count": len(kept), "error": None, **rerank_meta}
        if not kept and all_scores:
            best = round(max(all_scores), 4)
            payload["best_score"] = best
            payload["hint"] = (
                f"粗召回 {len(items)} 个候选块，但最高{('精排' if outcome.applied else '相似度')}分数 "
                f"{best} 仍低于阈值 {threshold}，已全部过滤。"
                "知识库中可能没有与该问题相关的内容，请告知用户未找到，不要编造。"
            )
        return payload

    def _recall(self, question: str, recall_n: int) -> dict[str, Any]:
        """粗召回：向量检索 + BM25 检索，RRF 融合

        Returns:
            dict 含 items（按融合顺序排列的候选，每项带 _pos/text/metadata/
            vector_similarity）、vector_hits、bm25_hits、bm25_error
        """
        # --- 向量召回（主路，失败则整个检索失败——embedding 是硬依赖）---
        query_embedding = _embed_batch([question])[0]
        raw = self.collection.query(
            query_embeddings=[query_embedding],
            n_results=min(recall_n, self.collection.count()),
        )
        v_metadatas = (raw.get("metadatas") or [[]])[0]
        v_documents = (raw.get("documents") or [[]])[0]
        v_distances = (raw.get("distances") or [[]])[0]
        v_ids = (raw.get("ids") or [[]])[0]

        vector_ranked: list[str] = []
        vector_sim: dict[str, float] = {}
        for cid, distance in zip(v_ids, v_distances):
            similarity = round(1.0 - float(distance), 4)  # cosine distance -> similarity
            if similarity < Config.SCORE_THRESHOLD:  # 宽松粗筛，只挡明显无关
                continue
            vector_sim[cid] = similarity
            vector_ranked.append(cid)

        # --- BM25 召回（辅路，失败显式降级）---
        bm25_ranked, bm25_error = self._bm25.query(self.collection, question, recall_n)

        # --- RRF 融合；BM25 缺席时退化为纯向量顺序 ---
        if bm25_ranked:
            fused = rrf_fuse([vector_ranked, bm25_ranked], top_n=recall_n)
            fused_ids = [cid for cid, _ in fused]
        else:
            fused_ids = vector_ranked[:recall_n]

        # --- 拉取候选块全文与元数据 ---
        items: list[dict[str, Any]] = []
        if fused_ids:
            got = self.collection.get(ids=fused_ids, include=["documents", "metadatas"])
            by_id = {
                cid: (doc, meta)
                for cid, doc, meta in zip(
                    got.get("ids") or [], got.get("documents") or [], got.get("metadatas") or []
                )
            }
            for cid in fused_ids:  # 保持融合顺序
                if cid not in by_id:
                    continue
                doc, meta = by_id[cid]
                if not (doc or "").strip():
                    continue
                items.append(
                    {
                        "_pos": len(items),
                        "text": doc,
                        "metadata": meta or {},
                        # BM25 独有召回的块没有余弦分数，记 None
                        "vector_similarity": vector_sim.get(cid),
                    }
                )

        return {
            "items": items,
            "vector_hits": len(vector_ranked),
            "bm25_hits": len(bm25_ranked),
            "bm25_error": bm25_error,
        }

    # ------------------------------------------------------------------ #
    # 文档管理
    # ------------------------------------------------------------------ #

    def list_documents(self) -> dict[str, Any]:
        """列出知识库中的所有文档及其块数、页码范围"""
        if self.collection.count() == 0:
            return {"documents": [], "count": 0}

        all_meta = self.collection.get(include=["metadatas"]).get("metadatas") or []
        docs: dict[str, dict[str, Any]] = {}
        for m in all_meta:
            source = m.get("source", "<unknown>")
            entry = docs.setdefault(
                source,
                {"source": source, "doc_id": m.get("doc_id", ""), "chunks": 0, "pages": set()},
            )
            entry["chunks"] += 1
            if m.get("page") is not None:
                entry["pages"].add(m["page"])

        documents = [
            {**d, "pages": sorted(d["pages"])} for d in sorted(docs.values(), key=lambda x: x["source"])
        ]
        return {"documents": documents, "count": len(documents)}

    def delete_document(self, source: str) -> str:
        """按源文件路径删除单个文档的所有块（路径匹配忽略大小写与分隔符差异）"""
        source = (source or "").strip()
        if not source:
            return "错误: source 不能为空（可先用 list_documents 查看准确的文件路径）"

        with self._write_lock:
            existing = self._chunks_of_source(source)
            if not existing:
                return f"知识库中不存在该文档: {source}"
            self._delete_by_source(source)
            # 删除后 BM25 索引必须失效，否则已删块仍会被关键词召回
            self._bm25.bump_version()

        return f"已删除文档 {_display_name(source)}，共 {len(existing)} 个文档块"

    def clear(self) -> str:
        """清空知识库（删除并重建集合）"""
        with self._write_lock:
            try:
                self.chroma_client.delete_collection(self.COLLECTION_NAME)
            except Exception:  # 集合不存在时忽略
                logger.debug("集合不存在，无需删除", exc_info=True)
            self.collection = self.chroma_client.get_or_create_collection(
                name=self.COLLECTION_NAME,
                metadata={"hnsw:space": "cosine", "embedding_model": Config.EMBEDDING_MODEL},
            )
            self._bm25.bump_version()
        logger.info("知识库已清空")
        return "知识库已清空"

    # ------------------------------------------------------------------ #
    # 内部工具
    # ------------------------------------------------------------------ #

    def _chunks_of_source(self, source: str) -> list[tuple[dict[str, Any], str]]:
        """取某一路径下现存的所有块（归一化匹配），返回 [(metadata, id), ...]

        全量扫描而非 where 精确过滤：ChromaDB 元数据过滤只支持字符串精确匹配，
        无法兼容历史数据中大小写/分隔符不同的同一路径。个人知识库规模下可接受。
        """
        target = _normalize_source(source)
        got = self.collection.get(include=["metadatas"])
        return [
            (m, i)
            for m, i in zip(got.get("metadatas") or [], got.get("ids") or [])
            if _normalize_source(m.get("source", "")) == target
        ]

    def _delete_by_source(self, source: str) -> None:
        """删除某一路径下所有块。ChromaDB 按存储值过滤，需逐个历史写法删除。"""
        for stored in {m.get("source", "") for m, _ in self._chunks_of_source(source)}:
            self.collection.delete(where={"source": stored})


# ---------------------------------------------------------------------- #
# 模块级工具函数（不依赖实例状态，便于单测）
# ---------------------------------------------------------------------- #


def _normalize_source(path: str) -> str:
    """归一化文档路径：统一分隔符、折叠 .与..，Windows 下额外忽略大小写

    ChromaDB 元数据过滤是精确字符串匹配，不归一化的话同一文件换个写法
    （D:/a.pdf vs d:\a.PDF）会被当成两个文档，产生重复入库或删除失效。
    """
    return os.path.normcase(os.path.normpath(path.strip()))


def _has_supported_extension(path: str) -> bool:
    """按扩展名粗判格式（详细校验交给各解析器）"""
    return os.path.splitext(path)[1].lower() in SUPPORTED_EXTENSIONS


def _sha256_file(path: str) -> str:
    """计算文件内容 sha256，用于文档去重与更新检测"""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _chunk_id(source: str, file_hash: str, chunk: str) -> str:
    """内容寻址的 chunk ID：同内容同 ID（配合 upsert 幂等），不同路径互不干扰"""
    digest = hashlib.sha256(f"{source}|{file_hash}|{chunk}".encode("utf-8")).hexdigest()
    return f"{file_hash[:12]}_{digest[:32]}"


def _display_name(path: str) -> str:
    return os.path.basename(path)


def _extract_pages(path: str) -> list[tuple[int | None, str]]:
    """按扩展名解析文档，返回 [(page_no, text), ...]

    page_no 为 1-based 页码，仅 PDF 有分页概念；其余格式返回 None
    （ChromaDB 元数据不支持 null，入库时会省略该键）。
    """
    ext = os.path.splitext(path)[1].lower()
    if ext == ".pdf":
        return _extract_pdf(path)
    if ext == ".docx":
        return [(None, _extract_docx(path))]
    return [(None, _read_text(path))]


def _extract_pdf(path: str) -> list[tuple[int | None, str]]:
    """PDF -> Markdown，逐页返回（pymupdf4llm 的 page_number 已是 1 基）"""
    pages = pymupdf4llm.to_markdown(path, page_chunks=True)
    return [
        (int(item["metadata"].get("page_number", 1)), (item.get("text") or "").strip())
        for item in pages
    ]


def _extract_docx(path: str) -> str:
    """DOCX -> 纯文本：正文段落按行拼接，表格逐行用 | 连接（python-docx 延迟导入）"""
    from docx import Document

    doc = Document(path)
    parts = [p.text.strip() for p in doc.paragraphs if p.text.strip()]
    for table in doc.tables:
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells if c.text.strip()]
            if cells:
                parts.append(" | ".join(cells))
    return "\n".join(parts)


def _read_text(path: str) -> str:
    """读取纯文本文件，编码依次尝试 utf-8-sig(BOM)/utf-8/gbk（兼容中文 Windows 文件）"""
    with open(path, "rb") as f:
        raw = f.read()
    for encoding in ("utf-8-sig", "utf-8", "gbk"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError(f"无法识别文件编码（已尝试 utf-8/gbk）: {_display_name(path)}")


def _embed_batch(texts: list[str]) -> list[list[float]]:
    """调用 DashScope embedding，带指数退避重试"""
    from dashscope import TextEmbedding

    last_error: Exception | None = None
    for attempt in range(Config.EMBED_MAX_RETRIES):
        try:
            response = TextEmbedding.call(model=Config.EMBEDDING_MODEL, input=texts)
            if response.status_code != 200:
                raise RuntimeError(f"Embedding API 返回 {response.status_code}: {response.message}")
            return [item["embedding"] for item in response.output["embeddings"]]
        except Exception as e:  # noqa: BLE001 - 统一记日志后重试
            last_error = e
            wait = 2**attempt
            logger.warning("Embedding 调用失败（第 %d 次）: %s，%ds 后重试", attempt + 1, e, wait)
            time.sleep(wait)
    raise RuntimeError(f"Embedding API 连续 {Config.EMBED_MAX_RETRIES} 次调用失败: {last_error}")


def results_to_text(payload: dict[str, Any]) -> str:
    """把检索结果序列化为给 MCP 客户端阅读的 JSON 文本"""
    return json.dumps(payload, ensure_ascii=False, indent=2)
