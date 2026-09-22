# 校园规则解码器 — 政策解读模块 MCP 接口契约

> 版本：v2.0・更新日期：2026-09-18
> 适用模块：规则分析 / 政策解读（campus_rule_check /query_policy）



***

## 一、概述

政策解读模块的 MCP 工具负责：接收用户的政策资格分析请求，查询政策知识库，拆解政策条件，结合用户个人信息逐项匹配，返回结构化的分析结果。

前端只做**字段渲染**，不做任何中文语义判断。所有 "进不进清单、属于哪个板块、用什么控件" 都由 MCP 返回的字段决定。



***

## 二、顶层返回结构

MCP 工具返回的 JSON 必须符合以下结构：



```
interface CampusRuleToolResult {

&#x20; type: 'campus\_rule\_analysis' | 'policy\_retrieval';  // 必须，前端据此判断渲染方式

&#x20; toolName: string;                                    // 调用的 MCP 工具名

&#x20; status: 'success' | 'partial' | 'error' | 'blocked'; // 结果状态

&#x20; summary: string;                                     // AI 整体回答（顶部话术，Markdown）

&#x20; conclusion?: string;                                 // ① 结论（一句话总结）

&#x20; evidences?: EvidenceItem\[];                          // ② 政策依据

&#x20; risks?: RiskItem\[];                                  // ③ 风险/缺失信息

&#x20; suggestions?: string\[];                              // ④ 建议下一步

&#x20; error?: ErrorInfo;                                   // 异常状态

&#x20; policyHits?: PolicyHit\[];                            // 政策检索命中条款

&#x20; conditionTable?: ConditionRow\[];                     // 逐条条件比对（扁平数组）

&#x20; conditionGroups?: ConditionGroup\[];                  // 条件比对（按类别分组，推荐）

&#x20; policyVersionId?: string;                            // 政策文件唯一标识（用于任务分组）

&#x20; policyFileName?: string;                             // 政策文件名（如《国家奖学金评定办法》2026版）

}
```

### 字段说明



| 字段                | 必填 | 说明                                                        |
| ----------------- | -- | --------------------------------------------------------- |
| `type`            | ✅  | 必须是 `'campus_rule_analysis'`，前端据此识别为政策解读结果                |
| `toolName`        | ✅  | 工具名称，如 `campus_rule_check`                                |
| `status`          | ✅  | `success`= 成功，`partial`= 部分成功，`error`= 失败，`blocked`= 越界拒绝 |
| `summary`         | ✅  | AI 整体回答，显示在页面顶部                                           |
| `conclusion`      | ❌  | 一句话结论，显示在汇总数字下方                                           |
| `conditionGroups` | 推荐 | 按类别分组的条件列表，前端链路直接用分组名                                     |
| `conditionTable`  | 可选 | 扁平条件数组，前端按 `category` 字段自动分组                              |
| `policyVersionId` | 推荐 | 政策文件唯一标识，用于任务分组（同一资格类别 + 同一文件才归为同一任务）                     |
| `policyFileName`  | 推荐 | 政策文件名，用于 "我的报告" 页面显示政策信息                                  |
| `evidences`       | ❌  | 政策依据列表（当前前端暂不渲染，预留）                                       |
| `risks`           | ❌  | 风险 / 缺失信息（当前前端暂不渲染，预留）                                    |
| `suggestions`     | ❌  | 建议下一步（当前前端暂不渲染，预留）                                        |
| `error`           | ❌  | 错误信息，status 为 error/blocked 时必填                           |



***

## 三、条件分组（ConditionGroup）

**推荐使用&#x20;**`conditionGroups`**&#x20;格式**，前端直接用分组名渲染横向链路。



```
interface ConditionGroup {

&#x20; id: string;      // 分组唯一ID，如 "group-academic"

&#x20; label: string;   // 分组名称，如 "学业成绩"、"英语成绩"、"综合表现"

&#x20; rows: ConditionRow\[];  // 该分组下的条件列表

}
```

### 示例



```
"conditionGroups": \[

&#x20; {

&#x20;   "id": "group-basic",

&#x20;   "label": "基础资格",

&#x20;   "rows": \[...]

&#x20; },

&#x20; {

&#x20;   "id": "group-academic",

&#x20;   "label": "学业成绩",

&#x20;   "rows": \[...]

&#x20; }

]
```

前端会把每个 `label` 渲染为横向链路上的一个节点，点击切换对应板块。



***

## 四、条件行（ConditionRow）

每个条件的详细匹配结果：



```
interface ConditionRow {

&#x20; id: string;                    // 条件唯一ID

&#x20; item: string;                  // 条件名称，如 "GPA成绩"、"CET-6成绩"

&#x20; match: 'met' | 'not\_met' | 'missing\_info' | 'needs\_manual\_review';  // 匹配状态

&#x20; userValue?: string;            // 用户当前值（关键！用于自动同步到「我的信息」）

&#x20; requirement?: string;          // 政策要求

&#x20; sourceQuote?: string;          // 政策原文引用

&#x20; category?: string;             // 所属分组（仅 conditionTable 模式下使用）

}
```

### match 状态说明



| 状态                    | 含义        | 前端渲染                 |
| --------------------- | --------- | -------------------- |
| `met`                 | 已满足       | 绿色 ✓，显示用户值 / 要求      |
| `missing_info`        | 待确认（信息缺失） | 琥珀色！，显示内嵌输入框，用户可直接填写 |
| `not_met`             | 未满足       | 红色 ×，显示用户值 / 要求      |
| `needs_manual_review` | 需人工审核     | 灰色，待确认处理             |

### userValue 字段（重要）

`userValue` 是前端自动同步到「我的信息」的数据源：



1. MCP 返回每个条件的 `userValue`（如 `"3.72"`、`"523"`、`"校级一等奖学金"`）

2. 前端遍历所有条件行，提取非空的 `userValue`

3. 通过条件名称（`item`）推断字段 key，自动同步到「我的信息」

4. 预设字段（GPA、CET-4/6、综合测评等）用预设映射；不在预设里的**自动创建动态字段**

5. 用户下次分析其他政策时，已同步的信息会自动带上，无需重复填写

**如果&#x20;**`userValue`**&#x20;为空或&#x20;**`"未提供"`**，该条件不会同步到「我的信息」。**

### category 字段（conditionTable 模式）

如果 MCP 返回的是 `conditionTable`（扁平数组）而不是 `conditionGroups`，前端会根据每条的 `category` 字段自动分组：



```
"conditionTable": \[

&#x20; { "id": "a1", "item": "GPA成绩", "match": "met", "userValue": "3.72", "category": "学业成绩" },

&#x20; { "id": "e1", "item": "CET-6", "match": "missing\_info", "userValue": "未提供", "category": "英语成绩" }

]
```

前端会按 `category` 值自动分成 "学业成绩"、"英语成绩" 等组。

**如果没有&#x20;**`category`**&#x20;字段，所有条件会归到一个 "全部条件" 组里。**



***

## 五、政策命中条款（PolicyHit）



```
interface PolicyHit {

&#x20; id: string;           // 条款唯一ID

&#x20; title: string;        // 条款标题，如 "第五条 学习成绩要求"

&#x20; source: string;       // 来源政策文件，如 "《国家奖学金评定办法》2026版"

&#x20; issuedDate?: string;  // 发布/施行日期

&#x20; keywords: string\[];   // 命中关键词

&#x20; quoteContent: string; // 引用原文

}
```

`policyHits[0].source` 会被前端用作政策文件标识的备选（当 `policyVersionId` 缺失时）。



***

## 六、错误信息（ErrorInfo）



```
interface ErrorInfo {

&#x20; type: 'warning' | 'error' | 'info';

&#x20; title: string;

&#x20; description: string;

}
```

当 `status` 为 `error` 或 `blocked` 时，前端显示错误信息而非条件卡片。



***

## 七、任务分组逻辑

前端根据以下两个字段决定分析任务的分组：



```
任务唯一标识 = goalKey（资格分析类别） + policyVersionId（政策文件）
```



| 场景              | 处理方式                        |
| --------------- | --------------------------- |
| 同一资格类别 + 同一政策文件 | 复用已有分析任务，报告快照版本递增（V1→V2→V3） |
| 同一资格类别 + 不同政策文件 | 创建新的分析任务，独立的报告快照序列          |
| 不同资格类别          | 创建新的分析任务                    |

**goalKey** 由前端根据用户提问自动识别（国家奖学金 / 研究生推免 / 三好学生等），无法识别时用动态 key。

**policyVersionId** 来自 MCP 返回的 `policyVersionId` 字段。如果 MCP 不返回此字段，所有任务都会用默认值 `'pv-default'`，导致同一资格类别下不同政策文件的报告混在一起。



***

## 八、报告快照生成

每次 MCP 返回新结果（messageId 不同）时，前端自动：



1. 更新分析任务的当前结果（`task.current`）

2. 生成新的报告快照（`ReportSnapshot`），版本号在该任务内递增

3. 报告快照锁定当时的：个人信息、政策版本、条件匹配结果、本次变化

报告快照不可修改，旧版本永远保留。



***

## 九、返回大小限制（重要）

**当前 MCP 存在返回结果过大被系统截断的问题**，导致前端无法渲染。请 MCP 端注意：



1. **只返回结构化摘要，不返回完整政策文本**

* ❌ 不要返回整篇政策文件内容

* ✅ 只返回拆解后的条件列表（conditionGroups /conditionTable）

1. **条件数量控制**

* 单次返回条件总数建议 ≤ 20 条

* 超过 20 条时，优先返回未满足和待确认的条件，已满足的可以合并

1. **原文引用精简**

* `sourceQuote` 每条 ≤ 200 字

* 只引用与该条件直接相关的条款，不要引用整章

1. **支持政策类型筛选**

* 用户提问中指明政策类型时（如 "奖学金"" 保研 "），只匹配一份政策文档

* 不要宽泛匹配多份政策后返回全部内容

1. **evidences /policyHits 数量控制**

* 建议 ≤ 5 条，只返回最相关的依据



***

## 十、完整示例



```
{

&#x20; "type": "campus\_rule\_analysis",

&#x20; "toolName": "campus\_rule\_check",

&#x20; "status": "success",

&#x20; "policyVersionId": "pv-national-scholarship-2026",

&#x20; "policyFileName": "《国家奖学金评定办法》2026版",

&#x20; "summary": "根据你当前提供的个人信息与《国家奖学金评定办法》2026版进行匹配分析。",

&#x20; "conclusion": "当前满足12项条件，3项待确认，1项未满足。建议补充 CET-6 成绩和科研经历后重新分析。",

&#x20; "conditionGroups": \[

&#x20;   {

&#x20;     "id": "group-basic",

&#x20;     "label": "基础资格",

&#x20;     "rows": \[

&#x20;       {

&#x20;         "id": "b1",

&#x20;         "item": "学籍状态",

&#x20;         "match": "met",

&#x20;         "userValue": "在籍本科生",

&#x20;         "requirement": "纳入全国普通高校招生计划的在籍本科生",

&#x20;         "sourceQuote": "第二条 申请国家奖学金的学生为高校在校生中二年级以上的学生。"

&#x20;       }

&#x20;     ]

&#x20;   },

&#x20;   {

&#x20;     "id": "group-academic",

&#x20;     "label": "学业成绩",

&#x20;     "rows": \[

&#x20;       {

&#x20;         "id": "a1",

&#x20;         "item": "GPA成绩",

&#x20;         "match": "met",

&#x20;         "userValue": "3.72",

&#x20;         "requirement": "GPA ≥ 3.50",

&#x20;         "sourceQuote": "第五条 学习成绩排名在评选范围内位于前10%。"

&#x20;       }

&#x20;     ]

&#x20;   },

&#x20;   {

&#x20;     "id": "group-english",

&#x20;     "label": "英语成绩",

&#x20;     "rows": \[

&#x20;       {

&#x20;         "id": "e2",

&#x20;         "item": "CET-6成绩",

&#x20;         "match": "missing\_info",

&#x20;         "userValue": "未提供",

&#x20;         "requirement": "CET-6 ≥ 425",

&#x20;         "sourceQuote": "第七条 外语水平要求。"

&#x20;       }

&#x20;     ]

&#x20;   },

&#x20;   {

&#x20;     "id": "group-research",

&#x20;     "label": "奖励与科研",

&#x20;     "rows": \[

&#x20;       {

&#x20;         "id": "r1",

&#x20;         "item": "科研成果",

&#x20;         "match": "not\_met",

&#x20;         "userValue": "暂无相关成果",

&#x20;         "requirement": "至少1项相关科研成果",

&#x20;         "sourceQuote": "第九条 科研创新能力要求。"

&#x20;       }

&#x20;     ]

&#x20;   }

&#x20; ]

}
```



***

## 十一、前端渲染对应关系



| MCP 字段                     | 前端渲染位置                     |
| -------------------------- | -------------------------- |
| `summary`                  | 页面顶部副标题                    |
| `conclusion`               | 汇总数字下方的结论文字                |
| `conditionGroups[].label`  | 横向链路节点名称                   |
| `conditionGroups[].rows[]` | 对应板块的条件卡片                  |
| `row.match`                | 条件卡片状态色（绿 / 琥珀 / 红）+ 图标    |
| `row.userValue`            | 条件卡片 "当前：xxx"+ 自动同步到「我的信息」 |
| `row.requirement`          | 条件卡片 "要求：xxx"              |
| `row.sourceQuote`          | 条件卡片政策依据（展开查看）             |
| `policyFileName`           | 「我的报告」页面政策信息               |
| `status=error` + `error`   | 错误提示页面                     |



***

## 十二、变更记录



| 版本   | 日期         | 变更内容                                                                                                                     |
| ---- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| v1.0 | 2026-09-16 | 初始版本                                                                                                                     |
| v2.0 | 2026-09-18 | 新增 `policyVersionId`、`policyFileName` 字段；新增 `category` 字段支持扁平数组自动分组；明确任务分组逻辑；新增返回大小限制建议；明确 `userValue` 自动同步机制；新增动态字段支持说明 |