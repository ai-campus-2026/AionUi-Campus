# RAG MCP Server

基于阿里云 DashScope + ChromaDB 的**检索型** RAG MCP Server：为 AionUi Agent（或其他 MCP 客户端）提供知识库语义检索能力。

> 设计原则：本 server 只做检索，**不内置 LLM 生成**。它返回相关文档块（原文 + 来源 + 页码 + 重排序/向量分数），由调用方 Agent 自己的 LLM 基于这些材料生成答案。这样避免双倍 LLM 调用，也让 Agent 完全掌控上下文与引用格式。

## 设计亮点

**架构设计**

- **检索与生成分离**：只返回文档块原文 + 来源 + 页码 + 分数，不内置 LLM——避免双重 LLM 调用，Agent 完全掌控上下文与引用格式
- **工具描述即防幻觉提示**：`search` 的工具描述直接约束下游 Agent："结果为空说明没有相关内容，请直接告知用户，不要凭空编造，也不要盲目重试相同问题"

**数据管理**

- **幂等加载**：chunk ID 基于内容哈希（文件 sha256 + 块内容），配合 `upsert`——同一文件重复加载自动跳过，文件更新后重新加载自动替换旧版本，不产生重复数据
- **Embedding 模型一致性校验**：知识库元数据记录构建时的 embedding 模型，启动时校验。更换模型会在初始化阶段报错，而不是检索时静默返回垃圾结果
- **路径归一化**：文档路径统一 `normcase + normpath`，Windows 下大小写/分隔符写法不同的同一路径不会重复入库，删除也不会失效
- **页码溯源贯穿全链路**：PDF 按页解析分块，每块携带 `source`/`page`/`chunk_index`，检索结果可直接定位到原始页码

**检索质量**

- **两阶段检索**：宽召回（`RECALL_TOP_N`，默认 20）→ 重排序精排 → 返回 `TOP_K`（默认 5）。纯向量单次 top-3 的召回窗口太窄，正确答案常在第一轮就被挤出；先宽召回再精排可在几乎不增加延迟的情况下显著提升召回率
- **混合召回（向量 + BM25）**：向量检索对精确 token 天然弱势——文号（`重邮〔2024〕15号`）、条款号（`第五条`）、学院专名、数字阈值（`425分`）常被语义相近的无关块挤掉。BM25 补足这一路，两路结果经 **RRF 融合**（`score(d) = Σ 1/(k + rank)`，k=60）。RRF 只依赖**名次**不依赖分数量级，因此天然免疫 BM25 分数与余弦相似度尺度不可比的问题
- **rerank 精排**：`text-embedding-v4` 对中文政策文本区分度差，不相关内容也常有 0.4~0.6 的余弦，单靠余弦阈值无法可靠过滤。改用阿里云 `gte-rerank-v2` 对 (query, chunk) 做真实相关性打分，实测能把向量排序第 2 的块提到第 1
- **中文感知分块**：自定义分隔符优先级（段落 → 换行 → 。！？；，），按中文标点断句而非默认英文规则
- **显式降级，绝不静默**：rerank 或 BM25 调用失败时不假装成功，而是返回 `rerank_applied: false` + `rerank_error` + `rerank_hint` 告知 Agent「当前结果未经精排、可信度较低」，同时回退到向量/BM25 排序保证工具仍可用。前车之鉴：LLM 静默失败曾导致下游条件提取结果全空，排查耗时极久
- **阈值过滤与拒识**：精排分数低于 `RERANK_THRESHOLD` 的块不返回，避免无关内容污染 Agent 上下文；全被过滤时返回 `best_score` 与 `hint`，帮 Agent 区分"知识库为空"与"没有相关内容"，从源头抑制编造

**工程健壮性**

- **stdio 协议安全**：所有日志强制写 stderr，stdout 只传输 JSON-RPC，杜绝 print 污染协议流
- **并发安全**：同步 I/O 经 `asyncio.to_thread` 进线程池，不阻塞事件循环；写操作持互斥锁
- **真实超时保护**：rerank 调用用 `request_timeout` 下发 HTTP 读超时。注意不能用 `timeout`——那不是 SDK 具名参数，会被塞进请求体的 `parameters` 被服务端**静默忽略**（返回 200），造出"看似有超时保护、实际无限挂住"的假象
- **边界处理细致**：Embedding/rerank 指数退避重试、分批向量化（DashScope 单批上限）、`top_k` 夹取防越界、扫描件/空文档明确报错而非静默成功、全标点文档不会触发 BM25 除零崩溃

## 架构

```
AionUi Agent（自带 LLM）
        │  MCP 协议 (stdio)
        ▼
RAG MCP Server (Python, FastMCP)
  ├─ load_document        → 文档（PDF/TXT/MD/DOCX）→ 分块 → 向量化入库（幂等）
  ├─ load_pdf             → 同上，仅限 PDF（兼容保留）
  ├─ search               → 两阶段检索（见下）
  ├─ list_documents       → 列出知识库中的文档
  ├─ delete_document      → 删除单个文档
  └─ clear_knowledge_base → 清空知识库
        │
   ┌────┴─────────┐
   │  ChromaDB    │  向量数据库（本地持久化）
   │  DashScope   │  text-embedding-v4 向量化 / gte-rerank-v2 重排序
   │  本地内存     │  BM25 倒排（jieba 分词，随知识库写入自动失效重建）
   └──────────────┘
```

### search 两阶段检索流程

```
question
   │
   ├─①粗召回（宽窗口 RECALL_TOP_N，默认 20）
   │    ├─ 向量召回：ChromaDB query → cosine ≥ SCORE_THRESHOLD(0.1) 宽松粗筛
   │    └─ BM25 召回：jieba 分词 → 词面重叠匹配（文号/条款号/数字阈值）
   │    → RRF 融合两路名次（k=60）→ 去重候选集
   │
   ├─②精排：gte-rerank-v2 对 (question, 候选块) 打真实相关性分
   │    → 按 rerank_score 降序重排 → 过滤 < RERANK_THRESHOLD(0.25)
   │    → 截断至 TOP_K(5)
   │
   └─ 任一阶段失败 → 显式降级（rerank_applied=false + error + hint），
                    回退向量/BM25 排序，工具仍可用
```

## MCP 工具

| 工具                   | 参数                                               | 说明                                                                                                                    |
| ---------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `load_document`        | `file_path` (string, 必填)                         | 加载文档，按扩展名识别格式（PDF / TXT / MD / DOCX）。幂等：同一文件重复加载自动跳过；文件内容更新后重新加载会替换旧版本 |
| `load_pdf`             | `pdf_path` (string, 必填)                          | `load_document` 的 PDF 专用版（兼容保留）                                                                               |
| `search`               | `question` (string, 必填)；`top_k` (integer, 可选) | 两阶段检索（混合召回 + rerank 精排），返回 JSON：`results[]`（含 `text`/`source`/`page`/`rerank_score`/`vector_similarity`/`chunk_index`）及 `rerank_applied` 等元数据。低于精排阈值的结果被过滤 |
| `list_documents`       | -                                                  | 列出所有文档的来源路径、块数、页码范围                                                                                  |
| `delete_document`      | `source` (string, 必填)                            | 按 `list_documents` 返回的完整路径删除单个文档                                                                          |
| `clear_knowledge_base` | -                                                  | 清空 RAG 向量知识库（ChromaDB + BM25 索引），不可恢复。⚠️ 勿与 policy_search 的同名工具混淆——那个清的是结构化政策 JSON 库 |

`search` 返回示例：

```json
{
  "results": [
    {
      "text": "检索增强生成是一种结合检索与生成的技术……",
      "source": "d:\\docs\\report.pdf",
      "page": 3,
      "rerank_score": 0.4548,
      "vector_similarity": 0.6764,
      "chunk_index": 0
    }
  ],
  "count": 1,
  "error": null,
  "rerank_applied": true,
  "rerank_model": "gte-rerank-v2"
}
```

> `page` 仅 PDF 有（1-based），TXT/MD/DOCX 无分页概念，该字段为 `null`。
> `source` 为归一化后的路径（Windows 下统一小写与分隔符），路径匹配忽略大小写差异。
> `rerank_score` 是精排后的真实相关性分（0~1），也是最终排序与阈值过滤的依据；`vector_similarity` 是粗召回阶段的余弦相似度，仅作诊断参考。
> 仅由 BM25 召回、未进入向量结果集的块，其 `vector_similarity` 为 `null`。

**rerank 降级时**（API 失败、超时，或 `RERANK_ENABLED=false`）工具不会静默返回低质量结果，而是显式标注：

```json
{
  "results": [{ "text": "……", "rerank_score": null, "vector_similarity": 0.7835 }],
  "count": 5,
  "error": null,
  "rerank_applied": false,
  "rerank_model": "gte-rerank-v2",
  "rerank_error": "rerank 调用失败已降级: ReadTimeout: Read timed out.",
  "rerank_hint": "当前结果未经重排序精排，排序依据为向量/BM25 相似度，精度可能下降。"
}
```

> 降级时 `rerank_score` 全为 `null`，排序与过滤回退到 `vector_similarity`（阈值用 `SCORE_THRESHOLD`）。Agent 应据此向用户说明结果可信度较低。
> 若 BM25 也降级（如 jieba 缺失、知识库为空），会额外附带 `bm25_error` 字段说明原因。

结果全被阈值过滤时，`results` 为空并附带诊断字段，调用方 Agent 可据此判断"知识库为空"还是"没有相关内容"：

```json
{
  "results": [],
  "count": 0,
  "error": null,
  "rerank_applied": true,
  "rerank_model": "gte-rerank-v2",
  "best_score": 0.1943,
  "hint": "粗召回 20 个候选块，但最高精排分数 0.1943 仍低于阈值 0.25，已全部过滤。知识库中可能没有与该问题相关的内容，请告知用户未找到，不要编造。"
}
```

> `best_score` 是过滤前候选集中的最高分（rerank 生效时为精排分，降级时为余弦分）。Agent 拿到空结果时应**直接告知用户未找到**，不要编造，也不要盲目用相同问题重试。

## 快速开始

### 1. 安装依赖

```bash
cd rag-mcp-server
pip install -r requirements.txt
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，填入 DashScope API Key（[获取地址](https://dashscope.console.aliyun.com/)）。

### 3. 启动 / 测试

```bash
python server.py          # stdio 模式，等待 MCP 客户端连接
```

用 MCP Inspector 交互测试：

```bash
npx @modelcontextprotocol/inspector python server.py
```

运行单元测试（离线，不访问 DashScope）：

```bash
python -m pytest tests/ -v
```

## 在 AionUi 中配置

```json
{
  "mcpServers": {
    "rag": {
      "command": "python",
      "args": ["D:/AI-Campus-Workspace/AionUi-Campus/rag-mcp-server/server.py"],
      "cwd": "D:/AI-Campus-Workspace/AionUi-Campus/rag-mcp-server"
    }
  }
}
```

> API Key 从项目目录的 `.env` 读取，无需在 MCP 配置中明文传递。

## 配置说明

| 环境变量              | 默认值              | 说明                                                                        |
| --------------------- | ------------------- | --------------------------------------------------------------------------- |
| `DASHSCOPE_API_KEY`   | -                   | DashScope API Key（必填）                                                   |
| `EMBEDDING_MODEL`     | `text-embedding-v4` | Embedding 模型。**更换后需清空知识库重建**（server 启动时会校验模型一致性） |
| `CHROMA_PERSIST_DIR`  | `./chroma_data`     | ChromaDB 数据目录                                                           |
| `CHUNK_SIZE`          | `500`               | 分块大小（字符数）                                                          |
| `CHUNK_OVERLAP`       | `50`                | 分块重叠（字符数）                                                          |
| `TOP_K`               | `5`                 | 精排后 `search` 实际返回条数                                                |
| `RECALL_TOP_N`        | `20`                | 粗召回窗口大小。须显著大于 `TOP_K`，否则精排没有筛选空间                    |
| `SCORE_THRESHOLD`     | `0.1`               | 粗召回阶段余弦下限。仅作宽松粗筛，真正的质量过滤交给 `RERANK_THRESHOLD`     |
| `RERANK_THRESHOLD`    | `0.25`              | 精排分数下限，低于该值的块不返回（rerank 降级时回退用 `SCORE_THRESHOLD`）   |
| `RERANK_MODEL`        | `gte-rerank-v2`     | 重排序模型。见下方「模型选型」                                              |
| `RERANK_ENABLED`      | `true`              | 是否启用精排。关闭后 `search` 显式降级并标注                                |
| `RERANK_MAX_DOCS`     | `500`               | rerank 单次请求文档数上限（gte-rerank-v2 官方上限 500）                     |
| `RERANK_MAX_RETRIES`  | `2`                 | rerank 调用失败重试次数（指数退避）                                         |
| `RERANK_TIMEOUT`      | `30`                | HTTP 读超时（秒）。SDK 默认 300 秒对交互式检索过长                          |
| `BM25_ENABLED`        | `true`              | 是否启用 BM25 关键词召回                                                    |
| `RRF_K`               | `60`                | RRF 融合平滑常数。值越大，排名靠前的结果优势越弱                            |
| `EMBED_BATCH_SIZE`    | `10`                | Embedding 单批条数（v4 上限 10）                                            |
| `EMBED_MAX_RETRIES`   | `3`                 | Embedding 调用失败重试次数                                                  |
| `LOG_LEVEL`           | `INFO`              | 日志级别（日志输出到 stderr，不污染 stdio 协议）                            |

### 模型选型与阈值标定

| rerank 模型      | 可用性            | 实测表现                                                       |
| ---------------- | ----------------- | -------------------------------------------------------------- |
| `gte-rerank-v2`  | ✅ 200            | 分离度干净：相关 0.72 / 不相关 0.006~0.19，**适合阈值过滤（默认）** |
| `qwen3-rerank`   | ✅ 200            | 绝对分更高但底部噪声大（不相关也有 0.30），阈值难以切分        |
| `gte-rerank` v1  | ❌ 403 Access Denied | 已下线，**勿用**                                               |

`RERANK_THRESHOLD=0.25` 并非拍脑袋取值，而是用真实知识库（综测细则 docx + 推免细则 pdf，共 44 块）实测标定：

```
应拒识问题（奖学金评定 / 转专业条件 / 文号查询 / 食堂开门）rerank 最高分 = 0.1943
应命中问题（综测算法 / 推免条件 / 创新创业加分）        rerank 最低通过分 = 0.3076
                                                          → 真实间隙 [0.1943, 0.3076]
                                                          → 取中点 0.25，两侧余量各约 0.056
```

> ⚠️ 真实 500 字符块中相关内容会被上下文稀释，分数**显著低于**孤立短句测试值（孤立测试曾观测到 0.78）。调整阈值前必须用真实块分布重新标定，不可沿用短句实验值。

## 技术栈

| 组件       | 技术                                                           |
| ---------- | -------------------------------------------------------------- |
| MCP 协议   | mcp Python SDK（FastMCP）                                      |
| PDF 解析   | pymupdf4llm（PDF → Markdown，保留结构，逐页带页码）            |
| DOCX 解析  | python-docx（正文段落 + 表格文本）                             |
| 分块       | langchain RecursiveCharacterTextSplitter（中文句子感知分隔符） |
| Embedding  | DashScope text-embedding-v4                                    |
| 重排序     | DashScope gte-rerank-v2（两阶段检索的精排阶段）                |
| 关键词召回 | jieba（中文分词）+ rank_bm25（BM25Okapi），RRF 融合            |
| 向量数据库 | ChromaDB（cosine，本地持久化）                                 |
| 测试       | pytest（embedding / rerank / BM25 均用假实现，离线运行）       |

## 项目结构

```
rag-mcp-server/
├── server.py           # MCP Server 入口（FastMCP 工具定义）
├── rag_engine.py       # RAG 核心：解析、分块、向量化、两阶段检索、文档管理
├── hybrid_recall.py    # BM25 索引（jieba 分词，版本化缓存）+ RRF 融合
├── rerank_client.py    # gte-rerank-v2 精排客户端（超时/重试/显式降级）
├── config.py           # 配置管理（.env）
├── conftest.py         # pytest 根配置
├── tests/              # 单元测试（离线，假 embedding / 假 rerank）
├── requirements.txt    # Python 依赖
├── .env.example        # 环境变量模板
├── .env                # 实际配置（已 gitignore，自行创建）
└── chroma_data/        # ChromaDB 数据目录（自动生成）
```

## License

MIT
