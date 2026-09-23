/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 校园规则解码器项目的开发态 MCP 自动注册（白名单内的全部服务）。
 *
 * 设计目标：换一台电脑后 `git clone` 仓库 + 装好 Python 依赖，启动 AionUi 即可
 * 在 MCP 列表里看到全部校园 MCP（policy_search / rag / contract-scan /
 * policy-comparison / course_path_server，以仓库里实际存在的源码为准），
 * 不必再手动粘贴 mcp-config.json。
 *
 * 服务清单只认一个来源：common/config/campusMcp.ts 的 CAMPUS_MCP_WHITELIST
 * （识别、注册、Key 注入三处口径统一，不再各自维护列表）。本模块只做
 * 「仓库探测 + 按白名单注册」。
 *
 * 仅开发态生效：通过从 `__dirname` 向上查找仓库根（含 `policy-search/server.py`
 * 与 `rag-mcp-server/server.py` 两个标志文件）来判定。打包后的生产构建里这两个
 * 目录不会出现在 asar 内，探测自然失败，整段逻辑被跳过 —— 不会污染最终用户的
 * MCP 列表。
 *
 * 启用策略（enabled）：needsKey 的服务缺 Key 时注册为 disabled，避免 MCP 启动
 * 时因缺 Key 反复抛错刷屏；course-path-server 核心功能不需要 Key，始终 enabled
 * （CurriculumIngestService 按 enabled !== false 查找它）。
 *
 * Python 解释器走系统 PATH（`command: 'python'`），Windows 下若装的是 py launcher
 * 而 PATH 里没有 python，需要用户自行 `py -3 -m pip install ...` 后改 PATH，
 * 或在设置里把 command 改成 `py`。本模块不做解释器探测，避免引入额外依赖。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import type { IMcpServer } from '@/common/config/storage';
import { CAMPUS_MCP_WHITELIST, type CampusMcpWhitelistEntry } from '@/common/config/campusMcp';

/** 两个标志文件都找到才算仓库根，避免误判 */
const CAMPUS_MARKER_FILES = [
  path.join('policy-search', 'server.py'),
  path.join('rag-mcp-server', 'server.py'),
] as const;

/** 向上查找的最大层数。仓库结构 out/main/chunks → packages/desktop → repo 顶多 5 层，10 层留足余量 */
const MAX_WALK_UP = 10;

export interface CampusRepoLayout {
  /** 仓库根绝对路径 */
  repoRoot: string;
}

/**
 * 从给定目录向上查找校园规则解码器仓库根。
 *
 * 找不到（生产构建、仓库结构变动、用户没把 AionUi 装在仓库内）返回 null，
 * 调用方据此跳过整个 campus bootstrap，绝不抛异常打断主迁移流程。
 */
export function findCampusRepoLayout(startDir?: string): CampusRepoLayout | null {
  let current = startDir ?? __dirname;
  // path.dirname('/') === '/'，用 parent === current 兜底防止死循环
  for (let i = 0; i < MAX_WALK_UP; i += 1) {
    const markers = CAMPUS_MARKER_FILES.map((rel) => path.join(current, rel));
    if (markers.every((abs) => existsSync(abs))) {
      return { repoRoot: current };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * 由白名单条目算出服务入口脚本的绝对路径。
 *
 * scriptMarker 始终是 `/` 分隔的仓库相对路径（如 `policy-search/server.py`），
 * 这里拆成段再用 path.join 拼，Windows 下得到规范的反斜杠路径。
 */
export function campusServiceScriptPath(layout: CampusRepoLayout, entry: CampusMcpWhitelistEntry): string {
  return path.join(layout.repoRoot, ...entry.scriptMarker.split('/'));
}

/** bootstrap 阶段产出的 MCP 条目，与 runBackendMigrations 中的 McpImportServer 形状一致 */
export type CampusMcpImportServer = Partial<IMcpServer> & Pick<IMcpServer, 'name' | 'transport'>;

/**
 * 构造白名单内校园 MCP 的注册条目（仓库里没有对应源码的服务跳过）。
 *
 * @param layout    仓库布局，由 findCampusRepoLayout 给出
 * @param apiKey    DashScope API Key。空串表示用户尚未配置，needsKey 的服务此时
 *                  enabled=false，弹窗补齐 key 后会再把 enabled 翻回 true
 *                  （见 CampusApiKeyDialog）；course-path-server 不受影响。
 * @param pythonCmd Python 解释器命令，默认 'python'。预留给后续做"本地覆盖"用。
 */
export function buildCampusMcpServers(
  layout: CampusRepoLayout,
  apiKey: string,
  pythonCmd = 'python'
): CampusMcpImportServer[] {
  const trimmedKey = (apiKey || '').trim();
  const keyPresent = trimmedKey.length > 0;
  // env 留空对象而不是 { DASHSCOPE_API_KEY: '' }：各 server 的 config.py 都用
  // os.getenv 读取，空串和不传效果一样，但空串会在 original_json 里留下噪音字段
  const env: Record<string, string> = keyPresent ? { DASHSCOPE_API_KEY: trimmedKey } : {};

  const servers: CampusMcpImportServer[] = [];
  for (const entry of CAMPUS_MCP_WHITELIST) {
    const scriptPath = campusServiceScriptPath(layout, entry);
    if (!existsSync(scriptPath)) {
      // 部分检出（仓库里还没有这个服务）不是错误，跳过即可
      console.info('[Migration] campus MCP %s not registered (missing %s)', entry.name, entry.scriptMarker);
      continue;
    }

    const enabled = entry.needsKey ? keyPresent : true;
    const dir = entry.scriptMarker.split('/')[0];
    const keyNote = entry.needsKey ? '缺失 DASHSCOPE_API_KEY 时禁用' : '核心功能不依赖 DashScope Key';
    const config = {
      command: pythonCmd,
      args: [scriptPath],
      env,
    };

    servers.push({
      name: entry.name,
      description: `校园规则解码器 - ${entry.label} MCP（开发态自动注册，源码位于仓库 ${dir}/，${keyNote}）`,
      enabled,
      builtin: true,
      transport: {
        type: 'stdio',
        command: config.command,
        args: config.args,
        env: config.env,
      },
      original_json: JSON.stringify({ mcpServers: { [entry.name]: config } }, null, 2),
    });
  }
  return servers;
}

/**
 * 判断一个已存在的 MCP 条目是否需要因为「仓库被搬到了新路径」而更新 args。
 *
 * 与 runBackendMigrations 中浏览器 MCP 的漂移修复同思路：注册时把绝对路径写进
 * transport.args，只在「首次插入」时写一次。换电脑或 git clone 到不同目录后，
 * 这条路径就失效了，按名字判断「已注册」会让它永远不会被重新插入 —— 所以每次
 * 启动都对齐一次实际路径。
 *
 * 仅当条目是 builtin（本模块注册的）且 command/args 与期望不一致时才返回 true，
 * 避免覆盖用户手动改过的自定义条目。
 */
export function isCampusServerPathDrifted(existing: IMcpServer, desired: CampusMcpImportServer): boolean {
  if (existing.builtin !== true) return false;
  if (existing.transport.type !== 'stdio' || desired.transport.type !== 'stdio') return false;
  if (existing.transport.command !== desired.transport.command) return true;
  const existingArgs = existing.transport.args ?? [];
  const desiredArgs = desired.transport.args ?? [];
  if (existingArgs.length !== desiredArgs.length) return true;
  return existingArgs.some((arg, i) => arg !== desiredArgs[i]);
}
