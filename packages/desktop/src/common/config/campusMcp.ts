/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 校园 MCP 配置：已禁用自动注入 API Key，用户在 MCP 设置里手动配置即可。
 */

import type { IMcpServer } from './storage';

/** 已禁用自动注入，永远返回 false，不自动覆盖任何 MCP 配置 */
export function isCampusPythonMcp(_server: IMcpServer): boolean {
  return false;
}

/** 已禁用自动注入 */
export function collectCampusPythonServers(_servers: IMcpServer[]): IMcpServer[] {
  return [];
}

/** 检查 env 里是否已有 Key */
export function hasCampusEnvKey(server: IMcpServer): boolean {
  if (server.transport.type !== 'stdio') return false;
  return Boolean(server.transport.env?.DASHSCOPE_API_KEY?.trim());
}

/** 已禁用自动注入，直接返回原配置 */
export function withCampusApiKey(server: IMcpServer, _apiKey: string): IMcpServer {
  return server;
}
