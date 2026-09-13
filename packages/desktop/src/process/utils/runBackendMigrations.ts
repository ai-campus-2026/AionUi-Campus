/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { migrateConfigStorage, migrateLegacyMcpConfigToDb, migrateProviders } from '@/common/config/configMigration';
import { httpRequest } from '@/common/adapter/httpBridge';
import { mcpService } from '@/common/adapter/ipcBridge';
import type { ImageGenerationModelSetting } from '@/common/config/clientSettings';
import { BUILTIN_BROWSER_MCP_NAME } from '@/common/config/constants';
import {
  removeImageGenerationEnvKeys,
  resolveImageGenerationMcpEnv,
  type ImageGenerationMcpEnvResolveResult,
} from '@/common/config/imageGenerationMcpEnv';
import {
  collectCampusPythonServers,
  hasBootstrapCampusServer,
  hasCampusEnvKey,
  withCampusApiKey,
} from '@/common/config/campusMcp';
import { BUILTIN_IMAGE_GEN_NAME, type IMcpServer, type IProvider } from '@/common/config/storage';
import { getBuiltinMcpScriptPath, type ProcessConfig as ProcessConfigType } from './initStorage';
import {
  buildCampusMcpServers,
  findCampusRepoLayout,
  isCampusServerPathDrifted,
  type CampusMcpImportServer,
} from './campusMcpBootstrap';
import { migrateAssistantsToBackend } from './migrateAssistants';

type ConfigFile = typeof ProcessConfigType;
type MigrationStepResult = boolean;
type McpImportServer = Partial<IMcpServer> & Pick<IMcpServer, 'name' | 'transport'>;
type BackendClientPreferences = Record<string, unknown>;
const BUILTIN_CHROME_DEVTOOLS_NAME = 'chrome-devtools';

/**
 * 内置「应用内浏览器」MCP。
 *
 * 与 chrome-devtools 的区别：那个默认关闭，开启后会由 MCP 自己开一个独立 Chrome
 * 窗口 —— 用户在 APP 里看不见。这个默认开启，且强制连到 APP 自己的 CDP 端口，
 * Agent 的每一步操作都发生在用户能看到的侧边预览面板里。
 *
 * The built-in in-app browser MCP. Unlike `chrome-devtools` (default-disabled and
 * spawning its own separate Chrome window the user cannot see), this one is
 * enabled by default and pinned to the app's own CDP port, so every agent action
 * happens in the side preview panel where the user can watch it.
 */
const BUILTIN_BROWSER_SCRIPT = 'builtin-mcp-browser';

const LEGACY_BACKEND_CLIENT_PREFERENCE_KEYS = [
  'assistants',
  'migration.assistantEnabledFixed',
  'migration.coworkDefaultSkillsAdded',
  'migration.builtinDefaultSkillsAdded_v2',
  'migration.promptsI18nAdded',
  'migration.assistantsSplitCustom',
] as const;

async function cleanupLegacyClientPreferences(): Promise<void> {
  const payloadEntries = LEGACY_BACKEND_CLIENT_PREFERENCE_KEYS.map((key): [string, null] => [key, null]);
  const payload = Object.fromEntries(payloadEntries);
  await httpRequest<void>('PUT', '/api/settings/client', payload);
}

const CLEANUP_STEPS: Array<{
  name: string;
  run: () => Promise<void>;
}> = [{ name: 'cleanupLegacyClientPreferences', run: async () => cleanupLegacyClientPreferences() }];

async function fetchBackendClientPreferences(): Promise<BackendClientPreferences> {
  try {
    return (await httpRequest<BackendClientPreferences>('GET', '/api/settings/client')) || {};
  } catch {
    return {};
  }
}

async function fetchProviders(): Promise<IProvider[]> {
  try {
    return (await httpRequest<IProvider[]>('GET', '/api/providers')) || [];
  } catch (error) {
    console.warn('[Migration] MCP bootstrap could not load providers for image generation env resolution', error);
    return [];
  }
}

export function resolveImageGenerationMigrationConfig(
  backendPrefs: BackendClientPreferences,
  fileConfig?: ImageGenerationModelSetting
): ImageGenerationModelSetting | undefined {
  const backendConfig = backendPrefs['tools.imageGenerationModel'];
  if (backendConfig && typeof backendConfig === 'object') {
    return backendConfig as ImageGenerationModelSetting;
  }
  return fileConfig;
}

function resolveImageGenerationMigrationConfigSource(
  backendPrefs: BackendClientPreferences,
  fileConfig?: ImageGenerationModelSetting
): 'backend' | 'file' | 'none' {
  const backendConfig = backendPrefs['tools.imageGenerationModel'];
  if (backendConfig && typeof backendConfig === 'object') {
    return 'backend';
  }
  return fileConfig ? 'file' : 'none';
}

function logImageGenerationEnvResolution(
  result: ImageGenerationMcpEnvResolveResult,
  context: 'bootstrap' | 'update'
): void {
  if (result.ok === true) {
    console.info(
      '[Migration] image MCP env resolved via %s during %s, provider id: %s, platform: %s, model: %s, api key present: %s',
      result.source,
      context,
      result.provider.id,
      result.provider.platform,
      result.model,
      result.provider.api_key ? 'yes' : 'no'
    );
    return;
  }

  console.warn(
    '[Migration] image MCP env resolution failed during %s, reason: %s, message: %s, candidates: %s',
    context,
    result.reason,
    result.message,
    result.candidates?.join(',') || 'none'
  );
}

function buildBuiltinImageGenerationServer(
  resolution: ImageGenerationMcpEnvResolveResult,
  config?: ImageGenerationModelSetting
): McpImportServer {
  const scriptPath = getBuiltinMcpScriptPath('builtin-mcp-image-gen');
  const env = resolution.ok ? resolution.env : {};
  const serverConfig = {
    command: 'node',
    args: [scriptPath],
    env,
  };

  return {
    name: BUILTIN_IMAGE_GEN_NAME,
    description: 'Built-in image generation tool powered by AI models. Configure the model in Settings > Tools.',
    enabled: config?.switch === true && resolution.ok,
    builtin: true,
    transport: {
      type: 'stdio',
      command: 'node',
      args: [scriptPath],
      env,
    },
    original_json: JSON.stringify({ mcpServers: { [BUILTIN_IMAGE_GEN_NAME]: serverConfig } }, null, 2),
  };
}

function areStringArraysEqual(left?: string[], right?: string[]): boolean {
  const leftValue = left || [];
  const rightValue = right || [];
  return leftValue.length === rightValue.length && leftValue.every((item, index) => item === rightValue[index]);
}

function areStringRecordsEqual(left?: Record<string, string>, right?: Record<string, string>): boolean {
  const leftValue = left || {};
  const rightValue = right || {};
  const leftKeys = Object.keys(leftValue).toSorted();
  const rightKeys = Object.keys(rightValue).toSorted();
  return areStringArraysEqual(leftKeys, rightKeys) && leftKeys.every((key) => leftValue[key] === rightValue[key]);
}

function isSameStdioTransport(left: IMcpServer['transport'], right: IMcpServer['transport']): boolean {
  return (
    left.type === 'stdio' &&
    right.type === 'stdio' &&
    left.command === right.command &&
    areStringArraysEqual(left.args, right.args) &&
    areStringRecordsEqual(left.env, right.env)
  );
}

function buildBuiltinBrowserServer(): McpImportServer {
  const scriptPath = getBuiltinMcpScriptPath(BUILTIN_BROWSER_SCRIPT);
  const serverConfig = {
    command: 'node',
    args: [scriptPath],
  };

  return {
    name: BUILTIN_BROWSER_MCP_NAME,
    description:
      "Control AionUi's built-in browser (the side preview panel): open pages, click, type and read content. " +
      'Sign-in state is shared across tabs and preserved between sessions.',
    // 默认开启：用户装好即可用，无需任何配置
    // Enabled by default: works out of the box with zero configuration.
    enabled: true,
    builtin: true,
    transport: {
      type: 'stdio',
      command: serverConfig.command,
      args: serverConfig.args,
    },
    original_json: JSON.stringify({ mcpServers: { [BUILTIN_BROWSER_MCP_NAME]: serverConfig } }, null, 2),
  };
}

function buildDefaultMcpServers(): McpImportServer[] {
  const chromeConfig = {
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest'],
  };

  return [
    {
      name: BUILTIN_CHROME_DEVTOOLS_NAME,
      description: 'Default MCP server: chrome-devtools',
      enabled: false,
      builtin: true,
      transport: {
        type: 'stdio',
        command: chromeConfig.command,
        args: chromeConfig.args,
      },
      original_json: JSON.stringify({ mcpServers: { [BUILTIN_CHROME_DEVTOOLS_NAME]: chromeConfig } }, null, 2),
    },
    buildBuiltinBrowserServer(),
  ];
}

/**
 * 开发态：探测校园规则解码器仓库并构造 policy_search / rag 两个 MCP 条目。
 *
 * 仓库找不到（生产构建、AionUi 没装在仓库内）返回空数组，整段逻辑被跳过，
 * 不会影响最终用户的 MCP 列表。API Key 从后端 client preferences 读取，
 * 缺失时条目仍会注册但 enabled=false，等 CampusApiKeyDialog 补齐后再启用。
 */
function buildCampusDefaultServers(backendPrefs: BackendClientPreferences): CampusMcpImportServer[] {
  const layout = findCampusRepoLayout();
  if (!layout) {
    return [];
  }
  const rawKey = backendPrefs['tools.campusMcp.dashscopeApiKey'];
  const apiKey = typeof rawKey === 'string' ? rawKey : '';
  console.info(
    '[Migration] campus MCP repo detected at %s, dashscope key present: %s',
    layout.repoRoot,
    apiKey.trim() ? 'yes' : 'no'
  );
  return buildCampusMcpServers(layout, apiKey);
}

async function isCommandAvailable(command: string): Promise<boolean> {
  return await new Promise((resolve) => {
    execFile(command, ['--version'], { timeout: 3000 }, (error) => {
      if (!error) {
        resolve(true);
        return;
      }

      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        resolve(false);
        return;
      }

      resolve(true);
    });
  });
}

async function ensureBuiltinChromeDevtoolsAvailability(server?: IMcpServer): Promise<void> {
  if (
    !server ||
    server.name !== BUILTIN_CHROME_DEVTOOLS_NAME ||
    server.transport.type !== 'stdio' ||
    server.transport.command !== 'npx'
  ) {
    return;
  }

  const hasNpx = await isCommandAvailable(server.transport.command);
  if (hasNpx) {
    return;
  }

  try {
    await mcpService.testMcpConnection.invoke(server);
  } catch (error) {
    console.warn('[Migration] chrome-devtools MCP preflight failed', error);
  }
}

function buildOriginalJsonFromTransport(server: Pick<IMcpServer, 'name' | 'description' | 'transport'>): string {
  const transport_config =
    server.transport.type === 'stdio'
      ? {
          command: server.transport.command,
          args: server.transport.args || [],
          env: server.transport.env || {},
        }
      : {
          type: server.transport.type,
          url: server.transport.url,
          ...(server.transport.headers ? { headers: server.transport.headers } : {}),
        };

  return JSON.stringify(
    {
      mcpServers: {
        [server.name]: {
          ...(server.description ? { description: server.description } : {}),
          ...transport_config,
        },
      },
    },
    null,
    2
  );
}

async function ensureBootstrapMcpServersInDb(configFile: ConfigFile): Promise<void> {
  const [backendPrefs, fileImageConfig, providers] = await Promise.all([
    fetchBackendClientPreferences(),
    configFile.get('tools.imageGenerationModel').catch((): undefined => undefined),
    fetchProviders(),
  ]);
  const imageConfig = resolveImageGenerationMigrationConfig(backendPrefs, fileImageConfig);
  const imageConfigSource = resolveImageGenerationMigrationConfigSource(backendPrefs, fileImageConfig);
  const existing = await mcpService.listServers.invoke();
  const existingByName = new Map((existing ?? []).map((server) => [server.name, server]));
  const existingImageServer = existingByName.get(BUILTIN_IMAGE_GEN_NAME);
  const existingImageEnv =
    existingImageServer?.transport.type === 'stdio' ? existingImageServer.transport.env : undefined;
  const imageEnvResolution = resolveImageGenerationMcpEnv(imageConfig, providers, existingImageEnv);
  logImageGenerationEnvResolution(imageEnvResolution, 'bootstrap');
  const imageServer = buildBuiltinImageGenerationServer(imageEnvResolution, imageConfig);
  const defaultServers = buildDefaultMcpServers();
  const campusServers = buildCampusDefaultServers(backendPrefs);
  const missing = [...defaultServers, ...campusServers, imageServer].filter(
    (server) => !existingByName.has(server.name)
  );
  let imageServerUpdated = false;

  if (missing.length > 0) {
    await mcpService.batchImportServers.invoke({ servers: missing });
  }

  const existingChromeDevtools = existingByName.get(BUILTIN_CHROME_DEVTOOLS_NAME);
  if (
    existingChromeDevtools &&
    (existingChromeDevtools.builtin !== true ||
      !existingChromeDevtools.original_json ||
      existingChromeDevtools.original_json.trim() === '' ||
      existingChromeDevtools.original_json.trim() === '{}')
  ) {
    await mcpService.updateServer.invoke({
      id: existingChromeDevtools.id,
      data: {
        builtin: true,
        original_json: buildOriginalJsonFromTransport(existingChromeDevtools),
      },
    });
  }

  const refreshedServers = await mcpService.listServers.invoke();
  const chromeDevtoolsServer = refreshedServers.find((server) => server.name === BUILTIN_CHROME_DEVTOOLS_NAME);
  await ensureBuiltinChromeDevtoolsAvailability(chromeDevtoolsServer);

  if (
    imageEnvResolution.ok === true &&
    existingImageServer &&
    existingImageServer.transport.type === 'stdio' &&
    imageServer.transport.type === 'stdio'
  ) {
    const mergedEnv = {
      ...removeImageGenerationEnvKeys(existingImageServer.transport.env || {}),
      ...imageEnvResolution.env,
    };
    const updatedTransport = {
      ...imageServer.transport,
      env: mergedEnv,
    };
    const original_json = JSON.stringify(
      {
        mcpServers: {
          [BUILTIN_IMAGE_GEN_NAME]: {
            command: updatedTransport.command,
            args: updatedTransport.args || [],
            env: mergedEnv,
          },
        },
      },
      null,
      2
    );
    const imageTransportChanged = !isSameStdioTransport(existingImageServer.transport, updatedTransport);
    const imageOriginalJsonChanged = existingImageServer.original_json !== original_json;
    const imageServerChanged = imageTransportChanged || imageOriginalJsonChanged;
    console.info(
      '[Migration] image MCP bootstrap decision, server id: %s, transport changed: %s, json changed: %s, will update: %s',
      existingImageServer.id,
      imageTransportChanged ? 'yes' : 'no',
      imageOriginalJsonChanged ? 'yes' : 'no',
      imageServerChanged ? 'yes' : 'no'
    );
    if (imageServerChanged) {
      await mcpService.updateServer.invoke({
        id: existingImageServer.id,
        data: {
          transport: updatedTransport,
          original_json,
        },
      });
      imageServerUpdated = true;
    }
  } else if (existingImageServer && imageEnvResolution.ok === false) {
    console.warn(
      '[Migration] skipped image MCP env update because provider could not be resolved, server id: %s, reason: %s',
      existingImageServer.id,
      imageEnvResolution.reason
    );
  }

  /**
   * 修复浏览器 MCP 记录里过期的脚本绝对路径。
   *
   * 注册时把绝对路径写进了 transport.args，只在「首次插入」时写一次。应用被移动过
   * （用户把 .app 拖出 /Applications、Windows 重装到别的目录、开发时换 worktree）
   * 之后这条路径就失效了，而按名字判断「已注册」使它永远不会被重新插入 ——
   * 结果是浏览器工具永久失效且不会自愈。所以每次启动都对齐一次实际路径。
   *
   * Repair a stale absolute script path in the browser MCP record. The path is baked
   * into transport.args and only written on first insert, so once the app moves (user
   * drags the .app out of /Applications, a Windows reinstall to a different directory,
   * a developer switching worktrees) it goes stale — and because "already registered"
   * is decided by name, it is never re-inserted, leaving the browser tools broken with
   * no self-heal. Reconcile against the real path on every startup instead.
   */
  const existingBrowserServer = existing.find((server) => server.name === BUILTIN_BROWSER_MCP_NAME);
  let browserServerUpdated = false;
  if (existingBrowserServer) {
    const desiredBrowserServer = buildBuiltinBrowserServer();
    const browserTransportChanged = !isSameStdioTransport(
      existingBrowserServer.transport,
      desiredBrowserServer.transport
    );
    const browserJsonChanged = existingBrowserServer.original_json !== desiredBrowserServer.original_json;
    if (browserTransportChanged || browserJsonChanged) {
      console.info(
        '[Migration] browser MCP path drifted, server id: %s, transport changed: %s, json changed: %s',
        existingBrowserServer.id,
        browserTransportChanged ? 'yes' : 'no',
        browserJsonChanged ? 'yes' : 'no'
      );
      await mcpService.updateServer.invoke({
        id: existingBrowserServer.id,
        data: {
          transport: desiredBrowserServer.transport,
          original_json: desiredBrowserServer.original_json,
        },
      });
      browserServerUpdated = true;
    }
  }

  /**
   * 修复校园 MCP（policy_search / rag）记录里过期的脚本绝对路径，并同步 API Key。
   *
   * 与浏览器 MCP 同思路：换电脑或 git clone 到不同目录后，transport.args 里的
   * 绝对路径会失效，按名字判断「已注册」让它永远不会被重新插入。每次启动都对齐
   * 一次实际路径。同时把 backendPrefs 里最新的 DashScope Key 同步进 env ——
   * 这样 CampusApiKeyDialog 保存 key 后，下次启动 bootstrap 就会把 enabled
   * 翻回 true，不必等用户手动去设置里开。
   *
   * 注意：updateServer 的 data 字段不接受 enabled（类型上是
   * Pick<..., 'name'|'description'|'transport'|'original_json'|'builtin'>），
   * 启用/禁用必须走单独的 toggleServer 接口 —— 与 useMcpServerCRUD 里
   * persistEnabledState 的做法一致。
   */
  let campusServerUpdated = false;
  if (campusServers.length > 0) {
    for (const desired of campusServers) {
      const existingCampus = existingByName.get(desired.name);
      if (!existingCampus) continue;

      const pathDrifted = isCampusServerPathDrifted(existingCampus, desired);
      const existingEnv = existingCampus.transport.type === 'stdio' ? existingCampus.transport.env || {} : {};
      const desiredEnv = desired.transport.type === 'stdio' ? desired.transport.env || {} : {};
      const envChanged = !areStringRecordsEqual(existingEnv, desiredEnv);
      const enabledChanged = Boolean(existingCampus.enabled) !== Boolean(desired.enabled);

      if (!pathDrifted && !envChanged && !enabledChanged) continue;

      console.info(
        '[Migration] campus MCP %s drifted, path: %s, env: %s, enabled: %s',
        desired.name,
        pathDrifted ? 'yes' : 'no',
        envChanged ? 'yes' : 'no',
        enabledChanged ? 'yes' : 'no'
      );

      // transport / original_json 走 updateServer
      if (pathDrifted || envChanged) {
        await mcpService.updateServer.invoke({
          id: existingCampus.id,
          data: {
            transport: desired.transport,
            original_json: desired.original_json,
          },
        });
      }
      // enabled 单独走 toggleServer
      if (enabledChanged) {
        try {
          await mcpService.toggleServer.invoke({ id: existingCampus.id });
        } catch (toggleError) {
          // toggle 失败不致命：transport 已经对齐，下次启动还会再试
          console.warn(
            '[Migration] campus MCP %s toggleServer failed, will retry next launch',
            desired.name,
            toggleError
          );
        }
      }
      campusServerUpdated = true;
    }
  }

  /**
   * 通用 Key 注入：覆盖**全部** Python stdio MCP，而不只是 bootstrap 按名字注册的
   * policy_search / rag。用户手动添加的 contract-scan（源码在仓库外 D:/contract-guard）、
   * 以及后续新增的校园 MCP，都是 `python xxx/server.py` 形态、共用同一个 DashScope
   * Key，理应一并被自动识别并注入。
   *
   * 闸门：仅当（a）列表里存在 bootstrap 注册的内置 Python MCP（说明确为开发态），
   * 且（b）preferences 里存有非空 Key 时才执行 —— 生产构建里 Key 永远为空，整段被
   * 跳过，绝不会去碰最终用户自己装的无关 Python MCP。
   */
  const rawCampusKey = backendPrefs['tools.campusMcp.dashscopeApiKey'];
  const campusApiKey = typeof rawCampusKey === 'string' ? rawCampusKey.trim() : '';
  let campusKeyInjected = 0;
  if (campusApiKey) {
    const allServersNow = await mcpService.listServers.invoke();
    if (hasBootstrapCampusServer(allServersNow)) {
      for (const server of collectCampusPythonServers(allServersNow)) {
        if (server.transport.type !== 'stdio') continue;
        const currentKey = server.transport.env?.DASHSCOPE_API_KEY?.trim() || '';
        // 已经是对的 Key 就跳过（bootstrap 注册的条目上面那段漂移修复已经同步过）
        if (hasCampusEnvKey(server) && currentKey === campusApiKey) continue;

        const updated = withCampusApiKey(server, campusApiKey);
        console.info(
          '[Migration] injecting DashScope key into python MCP %s (had key: %s, enabled: %s)',
          server.name,
          hasCampusEnvKey(server) ? 'yes' : 'no',
          server.enabled ? 'yes' : 'no'
        );
        await mcpService.updateServer.invoke({
          id: server.id,
          data: {
            transport: updated.transport,
            original_json: updated.original_json,
          },
        });
        if (!server.enabled) {
          try {
            await mcpService.toggleServer.invoke({ id: server.id });
          } catch (toggleError) {
            console.warn(
              '[Migration] python MCP %s toggleServer failed during key injection, will retry next launch',
              server.name,
              toggleError
            );
          }
        }
        campusKeyInjected += 1;
      }
    }
  }

  console.info(
    '[Migration] MCP bootstrap completed, imported %d missing defaults, updated image server: %s, updated browser server: %s, updated campus servers: %s, injected key into %d python MCP(s), image config source: %s, image enabled: %s',
    missing.length,
    imageServerUpdated ? 'yes' : 'no',
    browserServerUpdated ? 'yes' : 'no',
    campusServerUpdated ? 'yes' : 'no',
    campusKeyInjected,
    imageConfigSource,
    imageConfig?.switch === true ? 'yes' : 'no'
  );
}

const MIGRATION_STEPS: Array<{
  name: string;
  run: (configFile: ConfigFile) => Promise<MigrationStepResult>;
}> = [
  {
    name: 'migrateLegacyMcpConfigToDb',
    run: async (configFile) => (await migrateLegacyMcpConfigToDb(configFile), true),
  },
  { name: 'migrateConfigStorage', run: async (configFile) => (await migrateConfigStorage(configFile), true) },
  { name: 'migrateProviders', run: async (configFile) => (await migrateProviders(configFile), true) },
  {
    name: 'ensureBootstrapMcpServersInDb',
    run: async (configFile) => (await ensureBootstrapMcpServersInDb(configFile), true),
  },
  { name: 'migrateAssistantsToBackend', run: async (configFile) => migrateAssistantsToBackend(configFile) },
];

async function syncBuiltinMcpConfig(configFile: ConfigFile): Promise<void> {
  const localMcpConfig = ((await configFile.get('mcp.config').catch((): IMcpServer[] => [])) || []) as IMcpServer[];
  const localBuiltinServers = localMcpConfig.filter((server) => server?.builtin === true);

  if (localBuiltinServers.length === 0) {
    return;
  }

  const backendSettings = (await httpRequest<Record<string, unknown>>('GET', '/api/settings/client')) || {};
  const backendMcpConfig = Array.isArray(backendSettings['mcp.config'])
    ? (backendSettings['mcp.config'] as IMcpServer[])
    : [];

  const mergedMcpConfig = [...backendMcpConfig.filter((server) => server?.builtin !== true), ...localBuiltinServers];

  if (JSON.stringify(backendMcpConfig) === JSON.stringify(mergedMcpConfig)) {
    return;
  }

  await httpRequest<void>('PUT', '/api/settings/client', { 'mcp.config': mergedMcpConfig });
  console.info(
    '[AionUi] Synced builtin MCP config to backend settings (%d builtin servers)',
    localBuiltinServers.length
  );
}

export async function runBackendMigrations(configFile: ConfigFile): Promise<void> {
  await CLEANUP_STEPS.reduce<Promise<void>>(async (previous, step) => {
    await previous;
    const start = Date.now();
    try {
      await step.run();
      console.info(`[AionUi] Backend migration step completed: ${step.name} (${Date.now() - start}ms)`);
    } catch (error) {
      console.error(`[AionUi] Backend migration step failed: ${step.name} (${Date.now() - start}ms)`, error);
    }
  }, Promise.resolve());

  await MIGRATION_STEPS.reduce<Promise<void>>(async (previous, step) => {
    await previous;
    const start = Date.now();
    try {
      const completed = await step.run(configFile);
      const elapsed = Date.now() - start;
      if (!completed) {
        console.warn(`[AionUi] Backend migration step incomplete: ${step.name} (${elapsed}ms)`);
        return;
      }
      console.info(`[AionUi] Backend migration step completed: ${step.name} (${elapsed}ms)`);
    } catch (error) {
      const elapsed = Date.now() - start;
      console.error(`[AionUi] Backend migration step failed: ${step.name} (${elapsed}ms)`, error);
    }
  }, Promise.resolve());

  const syncStart = Date.now();
  try {
    await syncBuiltinMcpConfig(configFile);
    console.info(`[AionUi] Backend migration step completed: syncBuiltinMcpConfig (${Date.now() - syncStart}ms)`);
  } catch (error) {
    console.error(`[AionUi] Backend migration step failed: syncBuiltinMcpConfig (${Date.now() - syncStart}ms)`, error);
  }
}
