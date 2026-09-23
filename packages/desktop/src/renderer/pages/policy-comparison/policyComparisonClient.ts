// ============================================================
// 政策对比 · AI 对话客户端
// 复用项目真实的对话链路：ipcBridge.conversation.create / sendMessage / responseStream
// 政策对比使用一个共享对话（conversation_id 持久化在 localStorage）。
// 失败时返回具体错误信息，由调用方在 UI 中可见地提示（不静默吞掉）。
// MCP 未配置或返回不可解析时，调用方降级 mock 并提示。
// ============================================================

import { ipcBridge } from '@/common';
import { normalizeToolMessages, type ToolMessage } from '@/common/chat/normalizeToolCall';
import type { IConfirmation } from '@/common/chat/chatLib';
import type { IProvider, IMcpServer, ISessionMcpServer, TProviderWithModel } from '@/common/config/storage';
import { isAionrsAssistant, type Assistant } from '@/common/types/agent/assistantTypes';
import { ensureBackendMcpCatalog, toSessionMcpServer } from '@renderer/hooks/mcp/catalog';
import { loadLatestConversationMessages } from '@renderer/utils/chat/messagePagination';
import { tryParsePolicyDiffResult } from './adaptDiffResult';
import type { PolicyDiffResult } from './types';

const CONV_KEY = 'policy-comparison-conv:v1';

let convId: string | null = null;

function load() {
  try {
    const raw = localStorage.getItem(CONV_KEY);
    if (raw && typeof raw === 'string') convId = raw;
  } catch {
    // ignore
  }
}
load();

function save(id: string) {
  convId = id;
  try {
    localStorage.setItem(CONV_KEY, id);
  } catch {
    // ignore
  }
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

/** 解析默认可用模型（与首页选择逻辑一致） */
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
    // ignore
  }
  return undefined;
}

/** 加载所有启用的 MCP 服务器（与首页创建会话逻辑一致） */
async function loadEnabledMcpServers(): Promise<{
  userServerIds: string[];
  sessionServers: ISessionMcpServer[];
}> {
  const all: IMcpServer[] = [];
  try {
    const { allServers } = await ensureBackendMcpCatalog();
    all.push(...allServers);
  } catch {
    // ignore
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
    // ignore
  }

  const enabled = all.filter((s) => s.enabled !== false && s.id);
  const userServerIds = enabled.map((s) => s.id);
  const sessionServers = enabled.map((s) => toSessionMcpServer(s));
  return { userServerIds, sessionServers };
}

/** 检查是否有可用的 MCP 服务器（未配置时返回 false） */
export async function checkMcpAvailable(): Promise<boolean> {
  try {
    const mcp = await loadEnabledMcpServers();
    return mcp.userServerIds.length > 0;
  } catch {
    return false;
  }
}

// ============================================================
// 工具权限确认：工作台是纯轮询、无聊天确认 UI，主动轮询待确认并自动放行
// ============================================================
let autoApproveTimer: ReturnType<typeof setTimeout> | null = null;
const handledConfirmations = new Set<string>();

function pickAllowValue(options?: IConfirmation['options']): string | null {
  const vals = (options ?? []).map((o) => String(o.value));
  for (const preferred of ['proceed_always_server', 'proceed_always_tool', 'proceed_always', 'proceed_once']) {
    if (vals.includes(preferred)) return preferred;
  }
  const fallback = vals.find((v) => !/cancel|deny|reject|stop|^no|否|取消/.test(v));
  return fallback ?? null;
}

async function approvePendingOnce(targetConvId: string): Promise<void> {
  let pending: IConfirmation[] = [];
  try {
    pending = (await ipcBridge.conversation.confirmation.list.invoke({ conversation_id: targetConvId })) ?? [];
  } catch (e) {
    console.warn('[policy-comparison] 读取待确认失败:', e);
    return;
  }
  for (const c of pending) {
    const key = c.call_id || c.id;
    if (!key || handledConfirmations.has(key)) continue;
    handledConfirmations.add(key);
    const value = pickAllowValue(c.options);
    if (!value) continue;
    console.log('[policy-comparison] 自动批准 call_id=%s value=%s', key, value);
    try {
      await ipcBridge.conversation.confirmation.confirm.invoke({
        conversation_id: targetConvId,
        call_id: key,
        msg_id: key,
        data: { value },
        always_allow: value.includes('always'),
      });
    } catch (e) {
      console.warn('[policy-comparison] 自动批准失败:', e);
    }
  }
}

export function beginAutoApprove(targetConvId: string): void {
  endAutoApprove();
  handledConfirmations.clear();
  void approvePendingOnce(targetConvId);
  autoApproveTimer = setInterval(() => {
    void approvePendingOnce(targetConvId);
  }, 1500);
}

export function endAutoApprove(): void {
  if (autoApproveTimer) {
    clearInterval(autoApproveTimer);
    autoApproveTimer = null;
  }
}

/** 创建（或复用）政策对比对话；失败返回具体错误 */
export async function ensureComparisonConversation(): Promise<{ id: string } | { error: string }> {
  if (convId) return { id: convId };

  let assistant: { id: string; locale: string; conversation_overrides: { model?: string } } | undefined;
  const resolvedModel = await pickDefaultModel();
  try {
    const list = await ipcBridge.assistants.list.invoke();
    const picked = pickDefaultAssistant(list);
    if (picked?.id) {
      assistant = {
        id: picked.id,
        locale: 'zh-CN',
        conversation_overrides: resolvedModel ? { model: resolvedModel.use_model } : {},
      };
    }
  } catch {
    // ignore
  }

  const mcp = await loadEnabledMcpServers();
  if (mcp.userServerIds.length === 0) {
    return { error: 'NO_MCP_CONFIGURED' };
  }

  try {
    const conv = await ipcBridge.conversation.create.invoke({
      name: '政策对比',
      model: resolvedModel,
      assistant,
      extra: {
        selected_mcp_server_ids: mcp.userServerIds,
        selected_session_mcp_servers: mcp.sessionServers,
      },
    });
    if (conv && conv.id) {
      save(conv.id);
      console.log(
        `[policy-comparison] conversation created: id=${conv.id} mcp=${mcp.userServerIds.length} user-servers`
      );
      ipcBridge.conversation.ensureRuntime.invoke({ conversation_id: conv.id }).catch(() => {});
      return { id: conv.id };
    }
    return { error: '创建对话失败（后端未返回会话）' };
  } catch (e) {
    console.error('[policy-comparison] create conversation failed:', e);
    return { error: errText(e) };
  }
}

/** 向对话发送对比请求；失败返回具体错误 */
export async function sendComparisonRequest(
  id: string,
  oldFileName: string,
  newFileName: string
): Promise<{ ok: boolean; error?: string; isConflict?: boolean }> {
  beginAutoApprove(id);
  const text = `你现在必须调用 compare_policy_versions 这个 MCP 工具来对比两个政策文件的差异，不要自己手动分析。

旧政策文件：${oldFileName}
新政策文件：${newFileName}

调用完成后，直接把工具返回的完整 JSON 结果原样返回给我，不要自己总结，不要添加任何额外内容。`;
  try {
    await ipcBridge.conversation.sendMessage.invoke({ conversation_id: id, input: text });
    return { ok: true };
  } catch (e) {
    console.error('[policy-comparison] sendMessage failed:', e);
    const msg = errText(e);
    const isConflict = /409|already running|CONFLICT/i.test(msg);
    return { ok: false, error: msg, isConflict };
  }
}

export type DiffLoadStatus = 'ok' | 'no_tool_output' | 'parse_failed';

export interface LoadedDiffResult {
  status: DiffLoadStatus;
  result?: PolicyDiffResult;
  /** 产生该结果的工具消息 id（用于判断结果是否更新） */
  messageId?: string;
}

/**
 * 加载对话最近一条可解析的政策对比工具结果。
 * 两段式解析（与规则分析一致）：
 *   1. 先尝试分页消息中的 output
 *   2. 解析失败时，从数据库加载完整消息重新解析
 * 无可用结果时返回 null。
 */
export async function loadLatestDiffResult(conversationId: string): Promise<LoadedDiffResult> {
  try {
    const page = await loadLatestConversationMessages(conversationId, { limit: 100, contentMode: 'full' });
    const toolMsgs = (page.items ?? []).filter(
      (m): m is ToolMessage => m.type === 'tool_call' || m.type === 'tool_group' || m.type === 'acp_tool_call'
    );
    // MCP 没有返回任何工具结果（可能还在运行或调用超时）
    if (toolMsgs.length === 0) return { status: 'no_tool_output' };

    const normalized = normalizeToolMessages(toolMsgs);
    let hasOutput = false;
    for (let i = normalized.length - 1; i >= 0; i--) {
      const tool = normalized[i];
      if (!tool?.output) continue;
      hasOutput = true;
      // 第一段：分页消息中的 output
      const result = tryParsePolicyDiffResult(tool.output);
      if (result) {
        return { status: 'ok', result, messageId: tool.messageId };
      }
      // 第二段：分页 output 被截断 → 从数据库加载完整消息
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
              const fullResult = tryParsePolicyDiffResult(fullTool.output);
              if (fullResult) {
                return { status: 'ok', result: fullResult, messageId: fullTool.messageId ?? tool.messageId };
              }
            }
          }
        } catch {
          // continue
        }
      }
    }
    // 有工具输出但全部解析失败 → MCP 返回格式不对
    if (hasOutput) return { status: 'parse_failed' };
    return { status: 'no_tool_output' };
  } catch (e) {
    console.error('[policy-comparison] loadLatestDiffResult failed:', e);
    return { status: 'no_tool_output' };
  }
}
