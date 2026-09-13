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
 * 识别策略（重要）：**不靠硬编码 MCP 名字**，而是按「这是一个用 Python 解释器
 * 启动的 stdio MCP」来判定。校园规则解码器的所有 MCP（policy_search、rag、
 * contract-scan 合同审查，以及后续会加的文书生成等）都是 `python xxx/server.py`
 * 这种形态，且都依赖同一个阿里云 DashScope Key；而 AionUi 自带的内置 MCP
 * （浏览器、图像生成、chrome-devtools）一律用 node / npx 启动。因此「stdio +
 * Python 解释器命令」这条特征既能一网打尽全部校园 MCP（含用户手动添加、源码
 * 在仓库外的 contract-scan），又不会误伤应用自带的内置 MCP，新增 MCP 时也无需
 * 再来这里登记名字。
 */

import type { IMcpServer } from './storage';

/**
 * 取命令的 basename（去掉目录与可选的 .exe），用于跨平台判定解释器。
 * 兼容 `python` / `py` / `C:\Python312\python.exe` / `/usr/bin/python3`
 * / venv 里的 `D:/contract-guard/.venv/Scripts/python.exe` 等写法。
 */
function commandBasename(command: string): string {
  const trimmed = command.trim().replace(/^["']|["']$/g, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return (idx >= 0 ? trimmed.slice(idx + 1) : trimmed).toLowerCase();
}

const PYTHON_BASENAME_PATTERN = /^(python|pythonw|python3|python3\.\d+|py)(\.exe)?$/;

/** 判断一个 command 字符串是否是 Python 解释器（而非 node / npx 等）。 */
export function isPythonCommand(command: string): boolean {
  return PYTHON_BASENAME_PATTERN.test(commandBasename(command));
}

/**
 * 判断一个 MCP 条目是否是「依赖 DashScope 的 Python stdio MCP」——
 * 即需要被自动检测并注入 DASHSCOPE_API_KEY 的校园 MCP。
 */
export function isCampusPythonMcp(server: IMcpServer): boolean {
  if (server.transport.type !== 'stdio') return false;
  return isPythonCommand(server.transport.command || '');
}

/**
 * 判断一个条目是否是「本项目 bootstrap 自己注册的内置校园 MCP」（builtin===true
 * 且是 Python MCP）。它代表「当前处于开发态、且仓库已被探测到」—— 用作自动弹窗
 * 的闸门：只有存在这种条目时才提醒填 key，避免在生产构建里打扰只是恰好装了某个
 * 无关 Python MCP 的最终用户。
 */
export function isBootstrapCampusMcp(server: IMcpServer): boolean {
  return server.builtin === true && isCampusPythonMcp(server);
}

/** 从 MCP 列表里筛出全部需要注入 key 的 Python MCP（按 id 去重、保持原顺序）。 */
export function collectCampusPythonServers(servers: IMcpServer[]): IMcpServer[] {
  return servers.filter(isCampusPythonMcp);
}

/** 列表里是否存在「本项目 bootstrap 注册的内置校园 MCP」（开发态信号）。 */
export function hasBootstrapCampusServer(servers: IMcpServer[]): boolean {
  return servers.some(isBootstrapCampusMcp);
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
