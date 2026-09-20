// ============================================================
// 合同扫描 · AI 对话客户端
// 复用项目真实的对话链路，参考 policyComparisonClient.ts
// ============================================================

import { ipcBridge } from '@/common';
import { normalizeToolMessages, type ToolMessage } from '@/common/chat/normalizeToolCall';
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

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return '未知错误';
}

/** 与项目默认选择逻辑一致：优先 aionrs assistant */
function pickDefaultAssistant(list: Assistant[]): Assistant | null {
  const enabled = list.filter((a) => a.enabled !== false);
  return (
    enabled.find((a) => a.source === 'generated' && isAionrsAssistant(a)) ??
    enabled.find((a) => isAionrsAssistant(a)) ??
    enabled[0] ??
    null
  );
}

/** 解析默认可用模型 */
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

/** 加载所有启用的 MCP 服务器 */
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
  console.log('[合同扫描] 加载到的 MCP 服务器:', enabled.map((s) => ({ id: s.id, name: s.name, builtin: s.builtin })));
  // 不过滤 builtin 了，全部挂载
  const userServerIds = enabled.map((s) => s.id);
  console.log('[合同扫描] 挂载到会话的 MCP IDs:', userServerIds);
  const sessionServers = enabled.map((s) => toSessionMcpServer(s));
  return { userServerIds, sessionServers };
}

/** 确保对话存在 */
export async function ensureConversation(): Promise<string> {
  if (convId) return convId;

  let assistant: { id: string; locale: string; conversation_overrides: { model?: string } } | undefined;
  const model = await pickDefaultModel();
  try {
    const list = await ipcBridge.assistants.list.invoke();
    const picked = pickDefaultAssistant(list);
    if (picked?.id) {
      assistant = {
        id: picked.id,
        locale: 'zh-CN',
        conversation_overrides: model ? { model: model.use_model } : {},
      };
    }
  } catch {
    // ignore
  }

  const { userServerIds, sessionServers } = await loadEnabledMcpServers();
  if (userServerIds.length === 0) {
    throw new Error('未配置 MCP，请先在设置中启用');
  }

  const conv = await ipcBridge.conversation.create.invoke({
    name: '合同扫描',
    model: model,
    assistant,
    extra: {
      selected_mcp_server_ids: userServerIds,
      selected_session_mcp_servers: sessionServers,
    },
  });

  if (conv && conv.id) {
    save(conv.id);
    ipcBridge.conversation.ensureRuntime.invoke({ conversation_id: conv.id }).catch(() => {});
    return conv.id;
  }
  throw new Error('创建对话失败');
}

/** 检查 contract_scan MCP 是否可用 */
export async function checkMcpAvailable(): Promise<boolean> {
  // 临时先返回 true，直接试
  return true;
}

/** 发送扫描请求 */
export async function sendScanRequest(
  contractText: string,
  contractType: string,
): Promise<string> {
  const id = await ensureConversation();

  const typeLabel = contractType === 'auto' ? '自动识别' : contractType;
  const prompt = `请使用 contract_scan MCP 工具分析以下合同内容。合同类型：${typeLabel}。

合同内容：
${contractText}

请返回结构化的合同风险分析结果。`;

  await ipcBridge.conversation.sendMessage.invoke({
    conversation_id: id,
    input: prompt,
  });

  return id;
}

/** 从消息中提取合同扫描结果 */
async function extractResultFromMessages(conversationId: string): Promise<ContractReport | null> {
  try {
    const page = await loadLatestConversationMessages(conversationId, { limit: 100, contentMode: 'full' });
    const toolMsgs = (page.items ?? []).filter(
      (m): m is ToolMessage =>
        m.type === 'tool_call' || m.type === 'tool_group' || m.type === 'acp_tool_call',
    );
    if (toolMsgs.length === 0) return null;

    const normalized = normalizeToolMessages(toolMsgs);
    for (let i = normalized.length - 1; i >= 0; i--) {
      const tool = normalized[i];
      if (!tool?.output) continue;
      // 不过滤工具名字了，只要有 output 就试试解析

      // 先试分页里的 output
      try {
        const parsed = typeof tool.output === 'string' ? JSON.parse(tool.output) : tool.output;
        const report = tryParseContractScanResult(parsed);
        if (report) return report;
      } catch {
        // continue
      }

      // 截断了，从数据库加载完整消息
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
              try {
                const parsed = typeof fullTool.output === 'string' ? JSON.parse(fullTool.output) : fullTool.output;
                const report = tryParseContractScanResult(parsed);
                if (report) return report;
              } catch {
                // continue
              }
            }
          }
        } catch {
          // continue
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** 轮询获取扫描结果 */
export async function pollScanResult(
  conversationId: string,
  onStatusChange?: (status: ScanStatus) => void,
  timeoutMs = 120000,
): Promise<ContractReport> {
  const pollInterval = 2000;
  const startTime = Date.now();

  onStatusChange?.('scanning');

  let pollCount = 0;
  while (Date.now() - startTime < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollInterval));
    pollCount++;
    console.log(`[合同扫描] 第 ${pollCount} 次轮询...`);

    try {
      const page = await loadLatestConversationMessages(conversationId, { limit: 20, contentMode: 'full' });
      console.log(`[合同扫描] 拿到 ${page.items?.length ?? 0} 条消息`);
      const items = page.items ?? [];
      console.log('[合同扫描] 消息类型列表:', items.map((m: any) => m.type));
      
      // 打印 tool_call 的详细信息
      const toolMsgs = items.filter((m: any) => m.type === 'tool_call' || m.type === 'tool_group' || m.type === 'acp_tool_call');
      console.log(`[合同扫描] 找到 ${toolMsgs.length} 个工具消息`);
      toolMsgs.forEach((t: any, i: number) => {
        console.log(`[合同扫描] 工具消息 ${i}:`, {
          name: t.name || t.tool_name,
          status: t.status,
          output: t.output?.toString().slice(0, 200),
        });
      });
      
      const result = await extractResultFromMessages(conversationId);
      if (result) {
        console.log('[合同扫描] 提取到结果了！');
        onStatusChange?.('success');
        return result;
      }
    } catch (e) {
      console.error('[合同扫描] 轮询出错:', e);
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
