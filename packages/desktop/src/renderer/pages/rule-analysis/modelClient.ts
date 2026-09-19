// ============================================================
// 政策解读工作台 · AI 对话客户端
// 复用项目真实的对话链路：ipcBridge.conversation.create / sendMessage / responseStream
// 每个分析任务对应一个真实对话（conversation_id 持久化在 localStorage）。
// 失败时返回具体错误信息，由调用方在 UI 中可见地提示（不静默吞掉）。
// ============================================================

import { ipcBridge } from '@/common';
import { normalizeToolMessages, type ToolMessage } from '@/common/chat/normalizeToolCall';
import type { IProvider, IMcpServer, ISessionMcpServer, TProviderWithModel } from '@/common/config/storage';
import { isAionrsAssistant, type Assistant } from '@/common/types/agent/assistantTypes';
import { tryParseCampusRuleResult } from '@renderer/components/campus-rule/adaptPolicyResult';
import type { CampusRuleToolResult } from '@renderer/components/campus-rule/types';
import { ensureBackendMcpCatalog, toSessionMcpServer } from '@renderer/hooks/mcp/catalog';
import { loadLatestConversationMessages } from '@renderer/utils/chat/messagePagination';

const CONV_KEY = 'campus-rule-conv:v3';

const convIds = new Map<string, string>(); // taskId -> conversationId

function load() {
  try {
    const raw = localStorage.getItem(CONV_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string') convIds.set(k, v);
        }
      }
    }
  } catch {
    // 忽略损坏数据
  }
}
load();

function save() {
  try {
    localStorage.setItem(CONV_KEY, JSON.stringify(Object.fromEntries(convIds)));
  } catch {
    // 存储不可用时静默降级（内存态仍可用）
  }
}

export function getConvId(taskId: string): string | undefined {
  return convIds.get(taskId);
}

export function taskIdOfConv(convId: string): string | undefined {
  for (const [taskId, id] of convIds) {
    if (id === convId) return taskId;
  }
  return undefined;
}

export function setConvId(taskId: string, convId: string) {
  convIds.set(taskId, convId);
  save();
}

export function removeConvId(taskId: string) {
  convIds.delete(taskId);
  save();
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return '未知错误';
}

/** 与项目默认选择逻辑一致：优先 aionrs assistant，否则第一个启用的 */
function pickDefaultAssistant(list: Assistant[]): Assistant | null {
  const enabled = list.filter((a) => a.enabled !== false);
  return (
    enabled.find((a) => a.source === 'generated' && isAionrsAssistant(a)) ??
    enabled.find((a) => isAionrsAssistant(a)) ??
    enabled[0] ??
    null
  );
}

/**
 * 解析默认可用模型（与 Guid/首页选择逻辑一致）：
 * 第一个启用的 provider × 第一个启用的模型。后端创建 aionrs 会话需要 model。
 */
export async function pickDefaultModel(): Promise<TProviderWithModel | undefined> {
  try {
    const providers: IProvider[] = (await ipcBridge.mode.listProviders.invoke()) ?? [];
    for (const provider of providers) {
      if (provider.enabled === false || !provider.models?.length) continue;
      const model = provider.models.find((name) => provider.model_enabled?.[name] !== false);
      if (model) {
        const { models: _models, ...rest } = provider;
        return { ...rest, use_model: model };
      }
    }
  } catch {
    // 拿不到 provider 列表时退回无 model 创建（后端可能用 assistant 默认值）
  }
  return undefined;
}

/**
 * 加载所有启用的 MCP 服务器（后端用户服务器 + 内置 + 扩展），
 * 与项目首页/Guid 创建会话时挂载的 MCP 工具集合一致。
 */
async function loadEnabledMcpServers(): Promise<{
  userServerIds: string[];
  sessionServers: ISessionMcpServer[];
}> {
  const all: IMcpServer[] = [];
  try {
    const { allServers } = await ensureBackendMcpCatalog();
    all.push(...allServers);
  } catch {
    // 后端目录加载失败时继续尝试扩展服务器
  }
  try {
    const extServers = await ipcBridge.extensions.getMcpServers.invoke();
    if (extServers && extServers.length > 0) {
      for (const server of extServers) {
        all.push({
          id: String(server.id || ''),
          name: String(server.name || ''),
          description: server.description as string | undefined,
          enabled: server.enabled !== false,
          transport: server.transport as IMcpServer['transport'],
          created_at: (server.created_at as number) || Date.now(),
          updated_at: (server.updated_at as number) || Date.now(),
          original_json: String(server.original_json || '{}'),
          builtin: false,
        });
      }
    }
  } catch {
    // 扩展服务器加载失败时忽略
  }

  const enabled = all.filter((s) => s.enabled !== false && s.id);
  const userServerIds = enabled.filter((s) => s.builtin !== true).map((s) => s.id);
  const sessionServers = enabled.map((s) => toSessionMcpServer(s));
  return { userServerIds, sessionServers };
}

/** 创建（或复用）任务对应的真实 AI 对话；失败返回具体错误 */
export async function ensureConversation(
  taskId: string,
  name: string,
  options?: {
    /** 用户当前选中的 assistant id（与首页一致）；不传则回退默认选择 */
    assistantId?: string | null;
    /** 用户当前选中的模型（仅 aionrs 需要）；不传则回退默认选择 */
    model?: TProviderWithModel | undefined;
  },
): Promise<{ id: string } | { error: string }> {
  const cached = convIds.get(taskId);
  if (cached) return { id: cached };

  let assistant: { id: string; locale: string; conversation_overrides: { model?: string } } | undefined;
  const resolvedModel = options?.model ?? (await pickDefaultModel());
  try {
    const list = await ipcBridge.assistants.list.invoke();
    // 优先用用户当前选中的 assistant（与首页一致），否则回退默认选择
    const picked = options?.assistantId
      ? list.find((a) => a.id === options.assistantId && a.enabled !== false) ?? pickDefaultAssistant(list)
      : pickDefaultAssistant(list);
    if (picked?.id) {
      assistant = {
        id: picked.id,
        locale: 'zh-CN',
        conversation_overrides: resolvedModel ? { model: resolvedModel.use_model } : {},
      };
    }
  } catch {
    // 拿不到 assistant 列表时退回无 assistant 创建（后端可能仍可运行）
  }

  // 挂载所有启用的 MCP 服务器（与首页创建会话逻辑一致，否则会话无 MCP 工具）
  const mcp = await loadEnabledMcpServers();

  try {
    const conv = await ipcBridge.conversation.create.invoke({
      name,
      model: resolvedModel,
      assistant,
      extra: {
        selected_mcp_server_ids: mcp.userServerIds,
        selected_session_mcp_servers: mcp.sessionServers,
      },
    });
    if (conv && conv.id) {
      setConvId(taskId, conv.id);
      console.log(
        `[rule-analysis] conversation created: id=${conv.id} assistant=${assistant?.id ?? 'none'} model=${resolvedModel?.use_model ?? 'none'} mcp=${mcp.userServerIds.length} user-servers`,
      );
      // 预热运行时：会话首次打开时后端才物化 session，主动 ensure 尽早暴露失败
      ipcBridge.conversation.ensureRuntime.invoke({ conversation_id: conv.id }).catch(() => {
        // 预热失败不阻断发送流程
      });
      return { id: conv.id };
    }
    return { error: '创建对话失败（后端未返回会话）' };
  } catch (e) {
    console.error('[rule-analysis] create conversation failed:', e);
    return { error: errText(e) };
  }
}

/** 向真实对话发送一条消息（流式回复经 responseStream 回调）；失败返回具体错误 */
export async function sendToConversation(
  convId: string,
  text: string,
): Promise<{ ok: boolean; error?: string; isConflict?: boolean }> {
  try {
    await ipcBridge.conversation.sendMessage.invoke({ conversation_id: convId, input: text });
    return { ok: true };
  } catch (e) {
    console.error('[rule-analysis] sendMessage failed:', e);
    const msg = errText(e);
    // 后端 409：会话上一轮还在运行中，前端应保持等待状态而非报错
    const isConflict = /409|already running|CONFLICT/i.test(msg);
    return { ok: false, error: msg, isConflict };
  }
}

// ---------------------------------------------------------------------------
// 流式订阅（应用生命周期内单例订阅一次）
// ---------------------------------------------------------------------------

export interface AiStreamHandlers {
  /** 某条助手消息完整文本（finish 时一次性回调，一轮可能多条） */
  onText: (convId: string, text: string) => void;
  /** 本轮回复结束 */
  onDone: (convId: string) => void;
  /** 本轮回复出错 */
  onError: (convId: string, message: string) => void;
}

let streamStarted = false;
let handlersRef: AiStreamHandlers | null = null;
const buffers = new Map<string, Map<string, string>>();

function chunkOf(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object' && 'content' in data) {
    const c = (data as { content?: unknown }).content;
    if (typeof c === 'string') return c;
  }
  return '';
}

/**
 * 注册流式回调并开始监听（幂等：只订阅一次）。
 * 返回注销函数；注销后不再回调（订阅本身保留，避免重复注册）。
 */
export function subscribeStream(handlers: AiStreamHandlers): () => void {
  handlersRef = handlers;
  if (streamStarted) {
    return () => {
      if (handlersRef === handlers) handlersRef = null;
    };
  }
  streamStarted = true;
  return ipcBridge.conversation.responseStream.on((msg) => {
    const h = handlersRef;
    if (!h || !msg || !msg.conversation_id) return;
    const convId = msg.conversation_id;

    if (msg.type === 'content' || msg.type === 'text') {
      if (msg.msg_id) {
        const chunk = chunkOf(msg.data);
        if (chunk) {
          let m = buffers.get(convId);
          if (!m) {
            m = new Map();
            buffers.set(convId, m);
          }
          m.set(msg.msg_id, (m.get(msg.msg_id) ?? '') + chunk);
        }
      }
      return;
    }

    if (msg.type === 'finish') {
      const m = buffers.get(convId);
      if (m) {
        for (const text of m.values()) {
          const t = text.trim();
          if (t) h.onText(convId, t);
        }
      }
      buffers.delete(convId);
      h.onDone(convId);
      return;
    }

    if (msg.type === 'error') {
      buffers.delete(convId);
      h.onError(convId, chunkOf(msg.data) || 'AI 响应出错，请稍后再试');
    }
  });
}

// ---------------------------------------------------------------------------
// MCP 工具结果加载（policy.query_policy / rag search / campus_rule 等）
// ---------------------------------------------------------------------------

/** 从工具入参（JSON 字符串）中提取用户原始问题（用于解读页标题回显） */
function extractToolQuestion(input: unknown): string | undefined {
  let record: Record<string, unknown> | null = null;
  if (typeof input === 'string' && input.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (parsed && typeof parsed === 'object') record = parsed as Record<string, unknown>;
    } catch {
      return undefined;
    }
  } else if (input && typeof input === 'object') {
    record = input as Record<string, unknown>;
  }
  if (!record) return undefined;
  for (const key of ['question', 'query', 'prompt']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export interface LoadedRuleResult {
  result: CampusRuleToolResult;
  question?: string;
  /** 产生该结果的工具消息 id（用于判断结果是否更新） */
  messageId?: string;
}

/**
 * 加载某对话最近一条可解析的政策解读工具结果。
 * 两段式解析（与 MessageToolGroupSummary 一致）：
 *   1. 先尝试分页消息中的 output（可能被后端 compact 截断）
 *   2. 解析失败时，从数据库加载完整消息重新解析
 * 无可用结果时返回 null。
 */
export async function loadLatestRuleResult(convId: string): Promise<LoadedRuleResult | null> {
  try {
    const page = await loadLatestConversationMessages(convId, { limit: 100, contentMode: 'full' });
    const toolMsgs = (page.items ?? []).filter(
      (m): m is ToolMessage =>
        m.type === 'tool_call' || m.type === 'tool_group' || m.type === 'acp_tool_call',
    );
    if (toolMsgs.length === 0) return null;
    const normalized = normalizeToolMessages(toolMsgs);
    // 倒序找最近一条可解析为政策解读的结果
    for (let i = normalized.length - 1; i >= 0; i--) {
      const tool = normalized[i];
      if (!tool?.output) continue;
      // 第一段：分页消息中的 output
      const result = tryParseCampusRuleResult(tool.output);
      if (result) {
        return { result, question: extractToolQuestion(tool.input), messageId: tool.messageId };
      }
      // 第二段：分页 output 被截断 → 从数据库加载完整消息重新解析
      if (tool.conversationId && tool.messageId) {
        try {
          const fullMsg = await ipcBridge.database.getConversationMessage.invoke({
            conversation_id: tool.conversationId,
            message_id: tool.messageId,
          });
          if (fullMsg) {
            const fullNormalized = normalizeToolMessages([fullMsg as ToolMessage]);
            const fullTool = fullNormalized.find((t) => t.key === tool.key) ?? fullNormalized[0];
            if (fullTool?.output) {
              const fullResult = tryParseCampusRuleResult(fullTool.output);
              if (fullResult) {
                return {
                  result: fullResult,
                  question: extractToolQuestion(fullTool.input ?? tool.input),
                  messageId: fullTool.messageId ?? tool.messageId,
                };
              }
            }
          }
        } catch {
          // 单条完整消息加载失败不影响其他条目，继续尝试
        }
      }
    }
  } catch (e) {
    console.error('[rule-analysis] loadLatestRuleResult failed:', e);
  }
  return null;
}
