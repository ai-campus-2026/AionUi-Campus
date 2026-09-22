/**
 * 培养方案解析服务层。
 *
 * 职责：接收用户上传的培养方案文件，返回结构化的 ProgramPlan。
 *
 * 调用链路：创建静默 conversation → 发消息让 AI 调用 MCP 解析文件
 *         → 等待 AI 回复 → 提取 JSON → 适配为 ProgramPlan
 *
 * 失败降级：MCP 未配置 / 解析失败 / 超时 → 自动返回 mock 数据，
 *          并在 warnings 第一条加明显提示"当前为演示数据"。
 *
 * 上层（AcademicPathPage / ParsingState / ConfirmPlan）只依赖
 * parseProgramPlan 接口，不关心数据来自 mock 还是 MCP。
 */
import type { ProgramPlan, Course } from './types';
import { mockCurrentPlan } from './mockData';
import { ensureConversation } from '../rule-analysis/modelClient';
import { ipcBridge } from '@/common';

// ============================================================
// MCP 返回格式契约（做 MCP 的同学请按此结构返回 JSON）
// ============================================================
export interface McpProgramPlanResult {
  /** 是否解析成功。MCP 判断文件不是培养方案时返回 false */
  success: boolean;
  /** 专业名称，如 "软件工程"（success=true 时必填） */
  major?: string;
  /** 年级，如 "2024"（success=true 时必填） */
  grade?: string;
  /** 培养方案版本，如 "2024版" */
  version?: string;
  /** 毕业要求总学分（success=true 时必填） */
  totalCredits?: number;
  /** 课程列表（success=true 时必填） */
  courses?: Array<{
    /** 课程唯一标识，如课程编号 "CS101"，必须唯一 */
    id: string;
    /** 课程名称 */
    name: string;
    /** 学分 */
    credits: number;
    /** 课程类别枚举：required(必修) / elective(选修) / core(专业核心) / general(公共基础) / practice(实践) */
    category: 'required' | 'elective' | 'core' | 'general' | 'practice';
    /** 类别中文标签，如 "专业核心课" */
    categoryLabel: string;
    /** 建议修读学期，1-8 */
    suggestedSemester: number;
    /** 先修课程 id 列表，没有则为空数组 */
    prerequisites: string[];
  }>;
  /** 解析中不确定、需要用户确认的提示 */
  warnings?: string[];
  /** 失败错误码（success=false 时返回），如 "NOT_A_PROGRAM_PLAN" */
  errorCode?: string;
  /** 失败错误信息（success=false 时返回），展示给用户 */
  errorMessage?: string;
}

// ============================================================
// 解析结果
// ============================================================
export interface ParseResult {
  /** 结果类型：success = 解析成功（有课程数据），failed = MCP明确判断解析失败（文件无效） */
  type: 'success' | 'failed';
  /** 培养方案（type=success 时有值） */
  plan?: ProgramPlan;
  warnings: string[];
  /** 数据来源：mock = 演示数据（MCP未配置降级），mcp = 真实MCP解析 */
  source: 'mock' | 'mcp';
  fileName?: string;
  /** 降级原因（source=mock 时填） */
  fallbackReason?: string;
  /** 失败错误码（type=failed 时） */
  errorCode?: string;
  /** 失败错误信息（type=failed 时，展示给用户） */
  errorMessage?: string;
}

// ============================================================
// 主函数：先尝试真实 MCP，失败降级回 mock
// ============================================================
export async function parseProgramPlan(fileName?: string): Promise<ParseResult> {
  try {
    return await parseViaMcp(fileName);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn('[programParser] MCP解析失败，降级回mock:', reason);
    return buildMockFallback(fileName, reason);
  }
}

// ============================================================
// 真实 MCP 调用（通过 conversation 间接调用，与规则分析同构）
// ============================================================
async function parseViaMcp(fileName?: string): Promise<ParseResult> {
  // 0. 快速检测：是否有可用的 MCP 服务器。没有则立即降级 mock，不让用户等待。
  try {
    const servers = await ipcBridge.mcp.listServers.invoke();
    const enabled = Array.isArray(servers)
      ? servers.filter((s) => (s as { enabled?: boolean })?.enabled !== false)
      : [];
    if (enabled.length === 0) throw new Error('未检测到可用的MCP服务器');
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : 'MCP未就绪', { cause: e });
  }

  // 1. 创建静默 conversation（自动选 assistant / model / 挂载 MCP）
  const conv = await ensureConversation('academic-path-parser', '培养方案解析', {});
  if ('error' in conv) throw new Error(conv.error);

  // 2. 发送解析指令
  const prompt = buildParsePrompt(fileName);
  await ipcBridge.conversation.sendMessage.invoke({
    conversation_id: conv.id,
    input: prompt,
  });

  // 3. 等待 AI 回复完成（turnCompleted 事件 + 轮询兜底 + 90秒超时）
  const replyText = await waitForReply(conv.id, 30000);

  // 4. 从回复中提取 JSON
  const raw = extractJson(replyText);
  if (!raw) throw new Error('AI回复中未找到结构化JSON数据');

  // 5. MCP 明确返回解析失败（文件不是培养方案等）→ 返回 failed，不降级
  if (raw.success === false) {
    return {
      type: 'failed',
      warnings: [],
      source: 'mcp',
      fileName,
      errorCode: raw.errorCode ?? 'PARSE_FAILED',
      errorMessage: raw.errorMessage ?? '无法解析该文件，请确认上传的是有效的培养方案',
    };
  }

  // 6. 校验关键字段（success=true 或兼容旧格式无 success 字段但有数据）
  if (!raw.major || !Array.isArray(raw.courses) || raw.courses.length === 0) {
    throw new Error('MCP返回数据不完整（缺少专业或课程列表）');
  }

  // 7. 适配为 ProgramPlan
  const plan = adaptMcpPlan(raw, fileName);

  return {
    type: 'success',
    plan,
    warnings: raw.warnings ?? [],
    source: 'mcp',
    fileName,
  };
}

// ============================================================
// 辅助函数
// ============================================================

/** 构造发给 AI 的解析指令 */
function buildParsePrompt(fileName?: string): string {
  const fileLine = fileName ? `待解析文件：${fileName}\n\n` : '';
  return `${fileLine}请解析这份培养方案文件，提取所有课程信息，严格按以下JSON结构返回：

{
  "major": "专业名称",
  "grade": "年级",
  "version": "版本号",
  "totalCredits": 总学分数字,
  "courses": [
    {
      "id": "课程编号",
      "name": "课程名称",
      "credits": 学分数字,
      "category": "required|elective|core|general|practice",
      "categoryLabel": "类别中文名称",
      "suggestedSemester": 学期数字1-8,
      "prerequisites": ["先修课程id"]
    }
  ],
  "warnings": ["需要用户确认的提示"]
}

注意：
- 只返回JSON，不要任何自然语言解释
- id必须唯一，先修关系通过id引用
- category只能取五个枚举值，中文放在categoryLabel
- 没有先修课的课程prerequisites为空数组[]`;
}

/**
 * 等待 AI 回复完成。
 * 优先用 turnCompleted 事件（实时），轮询作为兜底。
 */
async function waitForReply(conversationId: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsub: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsub?.();
      reject(new Error('等待AI回复超时（30秒）'));
    }, timeoutMs);

    const finish = (text: string | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub?.();
      if (text) resolve(text);
      else reject(new Error(error ?? 'AI回复内容为空'));
    };

    // 主路径：监听 turnCompleted 事件
    try {
      unsub = ipcBridge.conversation.turnCompleted.on((event) => {
        if (event?.conversation_id !== conversationId) return;
        if (event?.status !== 'finished') return;
        const text = extractTextFromMessage(event?.last_message);
        finish(text, text ? undefined : 'turnCompleted但消息内容为空');
      });
    } catch {
      // 事件订阅失败，靠轮询兜底
    }

    // 兜底：每3秒轮询消息列表，检查是否已有assistant回复
    const pollInterval = setInterval(() => {
      if (settled) {
        clearInterval(pollInterval);
        return;
      }
      pollLatestAssistantMessage(conversationId)
        .then((text) => {
          if (text && !settled) finish(text);
        })
        .catch(() => {});
    }, 3000);

    // 清理时也清掉轮询
    const originalUnsub = unsub;
    unsub = () => {
      clearInterval(pollInterval);
      originalUnsub?.();
    };
  });
}

/** 轮询获取最新的 assistant 消息文本 */
async function pollLatestAssistantMessage(conversationId: string): Promise<string | null> {
  try {
    const page = await ipcBridge.database.getConversationMessages.invoke({
      conversation_id: conversationId,
      limit: 5,
    });
    const items: unknown[] =
      (page as { items?: unknown[]; data?: unknown[] })?.items ??
      (page as { items?: unknown[]; data?: unknown[] })?.data ??
      [];
    for (const msg of items) {
      if (msg?.role === 'assistant') {
        const text = extractTextFromMessage(msg);
        if (text && text.length > 10) return text;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** 从消息对象中提取纯文本 */
function extractTextFromMessage(msg: unknown): string {
  if (!msg) return '';
  const content = msg.content ?? msg.text ?? msg.body;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => {
        if (typeof c === 'string') return c;
        return c?.text ?? c?.content ?? '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** 从 AI 回复文本中提取 JSON 对象 */
function extractJson(text: string): McpProgramPlanResult | null {
  if (!text) return null;
  // 1. 提取 ```json ... ``` 代码块
  const jsonBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (jsonBlock) {
    try {
      return JSON.parse(jsonBlock[1]) as McpProgramPlanResult;
    } catch {
      /* fall through */
    }
  }
  // 2. 直接解析整个文本
  try {
    return JSON.parse(text) as McpProgramPlanResult;
  } catch {
    /* fall through */
  }
  // 3. 提取第一个 { 到最后一个 }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1)) as McpProgramPlanResult;
    } catch {
      /* return null */
    }
  }
  return null;
}

/** MCP 返回的 JSON → 前端 ProgramPlan 类型（按契约直接映射） */
export function adaptMcpPlan(raw: McpProgramPlanResult, fileName?: string): ProgramPlan {
  // 调用前已校验 success=true 且字段完整，这里安全取值
  const courses: Course[] = raw.courses.map((c) => ({
    id: c.id,
    name: c.name,
    credits: c.credits,
    category: c.category,
    categoryLabel: c.categoryLabel,
    semester: c.suggestedSemester,
    prerequisites: c.prerequisites ?? [],
  }));
  return {
    id: `plan-${Date.now()}`,
    name: fileName ? fileName.replace(/\.(pdf|doc|docx|jpg|jpeg|png)$/i, '') : `${raw.major}培养方案`,
    major: raw.major,
    grade: raw.grade,
    version: raw.version ?? '',
    totalCredits: raw.totalCredits,
    courses,
    createdAt: new Date().toISOString(),
    confirmedAt: undefined,
    isCurrent: false,
  };
}

/**
 * MCP 失败时的 mock 降级。
 * 关键：warnings 第一条加明显提示，让用户知道这不是真实解析结果。
 */
function buildMockFallback(fileName?: string, fallbackReason?: string): ParseResult {
  let plan: ProgramPlan = { ...mockCurrentPlan };
  if (fileName) {
    if (fileName.includes('计算机') || fileName.includes('计科')) {
      plan = { ...mockCurrentPlan, major: '计算机科学与技术' };
    } else if (fileName.includes('软件') || fileName.includes('软工')) {
      plan = { ...mockCurrentPlan, major: '软件工程' };
    } else if (fileName.includes('人工智能') || fileName.includes('AI')) {
      plan = { ...mockCurrentPlan, major: '人工智能' };
    }
  }
  const parsedPlan: ProgramPlan = {
    ...plan,
    id: `plan-${Date.now()}`,
    createdAt: new Date().toISOString(),
    confirmedAt: undefined,
    isCurrent: false,
  };
  const warnings: string[] = ['⚠ MCP 解析失败，当前显示的是演示数据（非真实文件解析结果）'];
  if (fallbackReason) {
    warnings.push(`失败原因：${fallbackReason}`);
  }
  warnings.push('有 3 条课程先修关系需要确认');
  return {
    type: 'success',
    plan: parsedPlan,
    warnings,
    source: 'mock',
    fileName,
    fallbackReason,
  };
}
