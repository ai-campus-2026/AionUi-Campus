// ============================================================
// 合同扫描 · AI 对话客户端
// 复用项目真实的对话链路，参考 rule-analysis/modelClient.ts
// ============================================================

import { ipcBridge } from '@/common';
import { normalizeToolMessages, type ToolMessage, type NormalizedToolCall } from '@/common/chat/normalizeToolCall';
import type { IProvider, IMcpServer, ISessionMcpServer, TProviderWithModel } from '@/common/config/storage';
import { isAionrsAssistant, type Assistant } from '@/common/types/agent/assistantTypes';
import { ensureBackendMcpCatalog, toSessionMcpServer } from '@renderer/hooks/mcp/catalog';
import { loadLatestConversationMessages } from '@renderer/utils/chat/messagePagination';
import { tryParseContractScanResult } from './adaptContractScanResult';
import type { ContractReport, ScanStatus } from './types';

const CONV_KEY = 'contract-scan-conv:v1';

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
  console.log('[contract-scan] all enabled MCP:', enabled.map((s) => ({id: s.id, name: s.name, builtin: s.builtin})));
  return { userServerIds, sessionServers };
}

/** 确保对话存在（创建时挂载全部启用的 MCP 服务器） */
export async function ensureConversation(): Promise<string> {
  if (convId) return convId;

  const model = await pickDefaultModel();

  let assistant: { id: string; locale: string; conversation_overrides: { model?: string } } | undefined;
  try {
    const list = (await ipcBridge.assistants.list.invoke()) ?? [];
    const picked = pickDefaultAssistant(list);
    if (picked?.id) {
      assistant = {
        id: picked.id,
        locale: 'zh-CN',
        conversation_overrides: model ? { model: model.use_model } : {},
      };
    }
  } catch {
    // 拿不到 assistant 列表时退回无 assistant 创建（后端可能仍可运行）
  }

  const mcp = await loadEnabledMcpServers();

  const result = await ipcBridge.conversation.create.invoke({
    name: '合同扫描',
    model,
    assistant,
    extra: {
      selected_mcp_server_ids: mcp.userServerIds,
      selected_session_mcp_servers: mcp.sessionServers,
    },
  });

  if (!result?.id) throw new Error('创建对话失败（后端未返回会话）');

  save(result.id);
  console.log(
    `[contract-scan] conversation created: id=${result.id} assistant=${assistant?.id ?? 'none'} mcp=${mcp.userServerIds.length} user-servers`,
  );
  // 预热运行时：会话首次打开时后端才物化 session，主动 ensure 尽早暴露失败
  ipcBridge.conversation.ensureRuntime.invoke({ conversation_id: result.id }).catch(() => {});
  return result.id;
}

/** 检查 contract-scan MCP 是否可用 */
export async function checkMcpAvailable(): Promise<boolean> {
  try {
    const all = (await ipcBridge.mcpService.listServers.invoke()) ?? [];
    return all.some((s: IMcpServer) => s.enabled !== false && (s.name ?? '').toLowerCase().includes('contract'));
  } catch {
    return false;
  }
}

/** 发送扫描请求；返回会话 id（供轮询使用） */
export async function sendScanRequest(contractText: string, contractType: string): Promise<{ id: string }> {
  const id = await ensureConversation();

  const typeLabel = contractType === 'auto' ? '自动识别' : contractType;
  const prompt = `你现在必须调用 contract_scan 这个 MCP 工具来分析下面的合同，不要自己手动分析。

工具参数要求：
- contract_text: 必须是下面【合同全文】里的完整内容，逐字复制，不要修改、不要总结、不要省略
- contract_type: "${contractType}"

调用完成后，直接把工具返回的完整 JSON 结果原样返回给我，不要自己总结，不要添加任何额外内容。

【合同全文】
${contractText}
【合同全文结束】`;

  await ipcBridge.conversation.sendMessage.invoke({
    conversation_id: id,
    input: prompt,
  });

  return { id };
}

/** 字符串/对象两种形态的输出都尝试解析 */
function parseOutput(output: unknown): ContractReport | null {
  try {
    const parsed = typeof output === 'string' ? JSON.parse(output) : output;
    return tryParseContractScanResult(parsed);
  } catch {
    return null;
  }
}

/** 从归一化工具消息中解析合同报告（两段式：分页输出 → 数据库完整消息） */
async function findReportInTools(tools: NormalizedToolCall[]): Promise<ContractReport | null> {
  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i];
    if (!tool?.output) continue;
    const name = (tool.name ?? '').toLowerCase();
    if (!name.includes('contract')) continue;

    // 第一段：分页消息中的 output
    const result = parseOutput(tool.output);
    if (result) return result;

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
            const fullResult = parseOutput(fullTool.output);
            if (fullResult) return fullResult;
          }
        }
      } catch {
        // continue
      }
    }
  }
  return null;
}

/**
 * 轮询获取扫描结果。
 * conversationId 传 null 时回退到模块内已保存的会话（兼容既有页面调用）。
 */
export async function pollScanResult(
  conversationId: string | null,
  onStatusChange?: (status: ScanStatus) => void,
  timeoutMs = 600000,
): Promise<ContractReport> {
  const id = conversationId ?? convId;
  if (!id) throw new Error('会话尚未创建');

  const pollInterval = 2000;
  const startTime = Date.now();

  onStatusChange?.('scanning');

  while (Date.now() - startTime < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollInterval));

    try {
      const page = await loadLatestConversationMessages(id, { limit: 100, contentMode: 'full' });
      console.log('[contract-scan] poll: got', page.items?.length, 'messages');
      const toolMsgs = (page.items ?? []).filter(
        (m): m is ToolMessage => m.type === 'tool_call' || m.type === 'tool_group' || m.type === 'acp_tool_call',
      );
      console.log('[contract-scan] tool messages:', toolMsgs.length, toolMsgs.map((m: any) => m.name));
      if (toolMsgs.length === 0) continue;

      const result = await findReportInTools(normalizeToolMessages(toolMsgs));
      if (result) {
        onStatusChange?.('success');
        return result;
      }
    } catch {
      // continue polling
    }
  }

  onStatusChange?.('timeout');
  throw new Error('扫描超时，请稍后重试');
}

/** 重置对话（重新扫描） */
export function resetConversation(): void {
  convId = null;
  try {
    localStorage.removeItem(CONV_KEY);
  } catch {
    // ignore
  }
}
