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
  try {
    await ensureBackendMcpCatalog();
    const all = (await ipcBridge.mcp.listServers.invoke()) ?? [];
    const enabled = all.filter((s: IMcpServer) => s.enabled !== false);
    const userServerIds = enabled.map((s: IMcpServer) => s.id);
    const sessionServers = enabled.map((s: IMcpServer) => toSessionMcpServer(s));
    return { userServerIds, sessionServers };
  } catch {
    return { userServerIds: [], sessionServers: [] };
  }
}

/** 确保对话存在 */
export async function ensureConversation(): Promise<string> {
  if (convId) return convId;

  const [assistants, model, { userServerIds, sessionServers }] = await Promise.all([
    ipcBridge.assistant.list.invoke(),
    pickDefaultModel(),
    loadEnabledMcpServers(),
  ]);

  const assistant = pickDefaultAssistant(assistants ?? []);
  if (!assistant) throw new Error('未找到可用的 AI 助手，请先在设置中配置。');

  const result = await ipcBridge.conversation.create.invoke({
    assistant_id: assistant.id,
    title: '合同扫描',
    model: model ?? null,
    mcp_server_ids: userServerIds,
    mcp_servers: sessionServers,
  });

  save(result.id);
  return result.id;
}

/** 检查 contract_scan MCP 是否可用 */
export async function checkMcpAvailable(): Promise<boolean> {
  try {
    const all = (await ipcBridge.mcp.listServers.invoke()) ?? [];
    return all.some((s: IMcpServer) => s.enabled !== false && s.name?.includes('contract'));
  } catch {
    return false;
  }
}

/** 发送扫描请求 */
export async function sendScanRequest(
  contractText: string,
  contractType: string,
): Promise<void> {
  const id = await ensureConversation();

  const typeLabel = contractType === 'auto' ? '自动识别' : contractType;
  const prompt = `请使用 contract_scan MCP 工具分析以下合同内容。合同类型：${typeLabel}。

合同内容：
${contractText}

请返回结构化的合同风险分析结果。`;

  await ipcBridge.conversation.sendMessage.invoke({
    conversation_id: id,
    content: prompt,
    stream: false,
  });
}

/** 从消息中提取合同扫描结果 */
function extractResultFromMessages(messages: unknown[]): ContractReport | null {
  const toolMsgs = normalizeToolMessages(messages as ToolMessage[]);
  for (const msg of toolMsgs) {
    const name = msg.tool_name || '';
    if (!name.toLowerCase().includes('contract_scan') && !name.toLowerCase().includes('contract')) continue;
    try {
      const parsed = typeof msg.tool_output === 'string' ? JSON.parse(msg.tool_output) : msg.tool_output;
      const report = tryParseContractScanResult(parsed);
      if (report) return report;
    } catch {
      // try next message
    }
  }
  return null;
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

  while (Date.now() - startTime < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollInterval));

    try {
      const msgs = await loadLatestConversationMessages(conversationId, 50);
      const result = extractResultFromMessages(msgs);
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
