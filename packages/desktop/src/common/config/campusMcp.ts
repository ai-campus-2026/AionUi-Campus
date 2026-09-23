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
 * 为校园服务——按固定名称（mcpServers 配置键，含别名）或 server.py 脚本路径标记
 * 匹配，二者任一命中即算。当前白名单（五个服务）：
 *   policy_search      -> policy-search/server.py        （政策结构化匹配，需要 Key）
 *   rag                -> rag-mcp-server/server.py       （RAG 向量检索，需要 Key）
 *   contract-scan      -> contract-guard/server.py       （合同审查，需要 Key）
 *   policy-comparison  -> policy-comparison/server.py    （政策对比，需要 Key）
 *   course_path_server -> course-path-server/server.py   （课程规划，核心功能不需要 Key）
 *
 * needsKey 字段说明：course-path-server 的核心功能（培养方案解析、课程规划、
 * 本地检索）完全本地可跑，DashScope 仅用于可选语义检索，缺 Key 不是故障，因此
 * 既不能把它算进「缺 Key 告警」，注册时也不能因缺 Key 而禁用。
 *
 * 历史上曾按「stdio + Python 解释器命令」泛化识别，会把用户自己添加的无关
 * Python MCP 也当成校园服务误写 Key、误启用（还可能覆盖其他 MCP 自己的同名
 * 环境变量），必须避免。新增校园 MCP 时在 CAMPUS_MCP_WHITELIST 里补一条即可。
 */

import {
  CAMPUS_CONTRACT_SCAN_NAME,
  CAMPUS_COURSE_PATH_NAME,
  CAMPUS_POLICY_COMPARISON_NAME,
  CAMPUS_POLICY_SEARCH_NAME,
  CAMPUS_RAG_NAME,
} from './constants';
import type { IMcpServer } from './storage';

/** 白名单项：固定名称（含别名）+ server.py 路径标记 + 是否依赖 DashScope Key。 */
export interface CampusMcpWhitelistEntry {
  /** AionUi MCP 列表里的条目名称（mcpServers 配置键；bootstrap 注册也用这个） */
  name: string;
  /**
   * 名称别名：手动导入/历史配置里可能出现的其他写法（全等匹配，大小写不敏感）。
   * course-path-server 的 FastMCP 自报名带连字符，CurriculumIngestService 两种
   * 写法都认，这里必须同步收录，否则手动导入的那份不会被识别、拿不到 Key 注入。
   */
  aliases?: readonly string[];
  /**
   * 入口脚本路径标记。匹配前会把 `\` 统一成 `/` 并转小写，因此
   * `D:\repo\policy-search\server.py` 与 `D:/repo/policy-search/server.py`、
   * 以及换 worktree / 仓库拷贝后的 `.../AionUi-Campus-SSH/contract-guard/server.py`
   * 都能命中。只匹配路径片段，不硬编码任何绝对路径。
   */
  scriptMarker: string;
  /**
   * 核心功能是否依赖 DASHSCOPE_API_KEY：
   * - true：缺 Key 时 bootstrap 注册为 enabled=false，弹窗/提示条按「缺 Key」提醒；
   * - false：无论有无 Key 都保持可用（course-path-server）。
   */
  needsKey: boolean;
  /** 展示用中文名（拼 MCP 描述等文案） */
  label: string;
}

/** 校园 MCP 显式白名单；新增服务时在此补一条（同时更新文件头注释）。 */
export const CAMPUS_MCP_WHITELIST: readonly CampusMcpWhitelistEntry[] = [
  {
    name: CAMPUS_POLICY_SEARCH_NAME,
    scriptMarker: 'policy-search/server.py',
    needsKey: true,
    label: '政策结构化匹配',
  },
  { name: CAMPUS_RAG_NAME, scriptMarker: 'rag-mcp-server/server.py', needsKey: true, label: 'RAG 向量检索' },
  { name: CAMPUS_CONTRACT_SCAN_NAME, scriptMarker: 'contract-guard/server.py', needsKey: true, label: '合同审查' },
  {
    name: CAMPUS_POLICY_COMPARISON_NAME,
    scriptMarker: 'policy-comparison/server.py',
    needsKey: true,
    label: '政策对比',
  },
  {
    name: CAMPUS_COURSE_PATH_NAME,
    // FastMCP 自报名 / 手动导入的连字符写法；与 CurriculumIngestService 的
    // SERVER_NAMES 保持一致
    aliases: ['course-path-server'],
    scriptMarker: 'course-path-server/server.py',
    needsKey: false,
    label: '课程规划',
  },
];

/** 统一路径分隔符并小写化，用于 args 与 scriptMarker 的跨平台比较。 */
function normalizePathLike(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

/** 判断条目名称是否命中白名单（大小写不敏感，容忍首尾空白；含别名）。 */
function matchesWhitelistName(server: IMcpServer): CampusMcpWhitelistEntry | undefined {
  const name = (server.name || '').trim().toLowerCase();
  return CAMPUS_MCP_WHITELIST.find((entry) =>
    [entry.name, ...(entry.aliases ?? [])].some((candidate) => candidate.toLowerCase() === name)
  );
}

/** 判断 stdio 条目的启动参数里是否带有白名单脚本路径标记。 */
function matchesWhitelistScript(server: IMcpServer): CampusMcpWhitelistEntry | undefined {
  if (server.transport.type !== 'stdio') return undefined;
  const args = server.transport.args ?? [];
  return CAMPUS_MCP_WHITELIST.find((entry) =>
    args.some((arg) => typeof arg === 'string' && normalizePathLike(arg).includes(entry.scriptMarker))
  );
}

/**
 * 返回条目命中的白名单项（名称或脚本路径任一命中即可，条目被改名、源码放在
 * 仓库外时靠路径兜底），未命中返回 undefined。
 */
export function campusWhitelistEntry(server: IMcpServer): CampusMcpWhitelistEntry | undefined {
  if (server.transport.type !== 'stdio') return undefined;
  return matchesWhitelistName(server) ?? matchesWhitelistScript(server);
}

/**
 * 判断一个 MCP 条目是否属于白名单内的校园 MCP —— 即需要被检测并注入
 * DASHSCOPE_API_KEY 的对象。
 */
export function isCampusMcp(server: IMcpServer): boolean {
  return Boolean(campusWhitelistEntry(server));
}

/** 从 MCP 列表里筛出全部白名单内的校园 MCP（保持原顺序）。 */
export function collectCampusMcpServers(servers: IMcpServer[]): IMcpServer[] {
  return servers.filter(isCampusMcp);
}

/**
 * 该条目的核心功能是否需要 DashScope Key（用于「缺 Key 告警」与 bootstrap
 * 启用策略）。未命中白名单的条目返回 false —— 不要用它判断是否校园服务。
 */
export function requiresCampusApiKey(server: IMcpServer): boolean {
  return campusWhitelistEntry(server)?.needsKey === true;
}

/** 判断 MCP 条目的 stdio env 里是否已带非空 DASHSCOPE_API_KEY。 */
export function hasCampusEnvKey(server: IMcpServer): boolean {
  if (server.transport.type !== 'stdio') return false;
  return Boolean(server.transport.env?.DASHSCOPE_API_KEY?.trim());
}

/**
 * 从现有 MCP 列表里找出第一个已存的 DASHSCOPE_API_KEY（弹窗预填用）。
 *
 * 用户可能没走弹窗、而是手动在某个校园 MCP 条目的 env 里填过 Key —— 仅读
 * preferences 会漏掉这种情况，导致弹窗明明检测到「缺 Key」却让用户重新找 Key。
 * 跨条目取到的 Key 同样只用于回填输入框，不改变「Key 只存 preferences 与
 * transport.env」的既有约定。
 */
export function findStoredCampusApiKey(servers: IMcpServer[]): string {
  for (const server of collectCampusMcpServers(servers)) {
    if (server.transport.type !== 'stdio') continue;
    const found = server.transport.env?.DASHSCOPE_API_KEY?.trim();
    if (found) return found;
  }
  return '';
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
