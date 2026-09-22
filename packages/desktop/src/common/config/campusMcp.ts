/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 校园规则解码器 MCP 的纯函数工具（common 层，main / renderer 共享）。
 *
 * 只依赖 IMcpServer 类型，不碰 node:fs / node:path，因此可以安全地被
 * renderer 的 CampusApiKeyDialog / ToolsModalContent 与 main 进程的
 * runBackendMigrations 同时引用。
 *
 * 识别策略（重要）：**显式白名单**。只有明确登记过的本团队校园 MCP 才会被识别
 * 为「需要 DashScope Key」——按固定名称（mcpServers 配置键）或 server.py 脚本
 * 路径标记匹配，二者任一命中即算。当前白名单（四个服务）：
 *   policy_search      -> policy-search/server.py
 *   rag                -> rag-mcp-server/server.py
 *   contract-scan      -> contract-guard/server.py
 *   policy-comparison  -> policy-comparison/server.py
 *
 * 历史上曾按「stdio + Python 解释器命令」泛化识别，会把用户自己添加的无关
 * Python MCP 也当成校园服务误写 Key、误启用（还可能覆盖其他 MCP 自己的同名
 * 环境变量），必须避免。新增校园 MCP 时在 CAMPUS_MCP_WHITELIST 里补一条即可。
 */

import {
  CAMPUS_CONTRACT_SCAN_NAME,
  CAMPUS_POLICY_COMPARISON_NAME,
  CAMPUS_POLICY_SEARCH_NAME,
  CAMPUS_RAG_NAME,
} from './constants';
import type { IMcpServer } from './storage';

/** 白名单项：固定名称 + server.py 路径标记。 */
interface CampusMcpWhitelistEntry {
  /** AionUi MCP 列表里的条目名称（mcpServers 配置键） */
  name: string;
  /**
   * 入口脚本路径标记。匹配前会把 `\` 统一成 `/` 并转小写，因此
   * `D:\repo\policy-search\server.py` 与 `D:/repo/policy-search/server.py`、
   * 以及换 worktree / 仓库拷贝后的 `.../AionUi-Campus-SSH/contract-guard/server.py`
   * 都能命中。只匹配路径片段，不硬编码任何绝对路径。
   */
  scriptMarker: string;
}

/** 校园 MCP 显式白名单；新增服务时在此补一条（同时更新文件头注释）。 */
export const CAMPUS_MCP_WHITELIST: readonly CampusMcpWhitelistEntry[] = [
  { name: CAMPUS_POLICY_SEARCH_NAME, scriptMarker: 'policy-search/server.py' },
  { name: CAMPUS_RAG_NAME, scriptMarker: 'rag-mcp-server/server.py' },
  { name: CAMPUS_CONTRACT_SCAN_NAME, scriptMarker: 'contract-guard/server.py' },
  { name: CAMPUS_POLICY_COMPARISON_NAME, scriptMarker: 'policy-comparison/server.py' },
];

/** 统一路径分隔符并小写化，用于 args 与 scriptMarker 的跨平台比较。 */
function normalizePathLike(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

/** 判断条目名称是否命中白名单（大小写不敏感，容忍首尾空白）。 */
function matchesWhitelistName(server: IMcpServer): boolean {
  const name = (server.name || '').trim().toLowerCase();
  return CAMPUS_MCP_WHITELIST.some((entry) => entry.name === name);
}

/** 判断 stdio 条目的启动参数里是否带有白名单脚本路径标记。 */
function matchesWhitelistScript(server: IMcpServer): boolean {
  if (server.transport.type !== 'stdio') return false;
  const args = server.transport.args ?? [];
  return CAMPUS_MCP_WHITELIST.some((entry) =>
    args.some((arg) => typeof arg === 'string' && normalizePathLike(arg).includes(entry.scriptMarker))
  );
}

/**
 * 判断一个 MCP 条目是否属于白名单内的校园 MCP —— 即需要被检测并注入
 * DASHSCOPE_API_KEY 的对象。名称命中或脚本路径命中均可（条目被改名、
 * 源码放在仓库外时靠路径兜底）。
 */
export function isCampusMcp(server: IMcpServer): boolean {
  if (server.transport.type !== 'stdio') return false;
  return matchesWhitelistName(server) || matchesWhitelistScript(server);
}

/** 从 MCP 列表里筛出全部白名单内的校园 MCP（保持原顺序）。 */
export function collectCampusMcpServers(servers: IMcpServer[]): IMcpServer[] {
  return servers.filter(isCampusMcp);
}

/** 判断 MCP 条目的 stdio env 里是否已带非空 DASHSCOPE_API_KEY。 */
export function hasCampusEnvKey(server: IMcpServer): boolean {
  if (server.transport.type !== 'stdio') return false;
  return Boolean(server.transport.env?.DASHSCOPE_API_KEY?.trim());
}

/**
 * 把 key 注入到一个 stdio MCP 条目的 transport.env，并返回更新后的完整条目
 * （同时把 enabled 翻成 true、同步重建 original_json）。非 stdio 条目原样
 * 返回（理论上不会发生，防御性处理）。
 *
 * 调用方只应传入白名单内的校园 MCP 条目（见 isCampusMcp / collectCampusMcpServers）。
 */
export function withCampusApiKey(server: IMcpServer, apiKey: string): IMcpServer {
  if (server.transport.type !== 'stdio') return server;
  const env = { ...server.transport.env, DASHSCOPE_API_KEY: apiKey };
  return {
    ...server,
    enabled: true,
    transport: {
      ...server.transport,
      env,
    },
    original_json: JSON.stringify(
      {
        mcpServers: {
          [server.name]: {
            ...(server.description ? { description: server.description } : {}),
            command: server.transport.command,
            args: server.transport.args || [],
            env,
          },
        },
      },
      null,
      2
    ),
  };
}
