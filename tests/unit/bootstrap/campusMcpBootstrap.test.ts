import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CAMPUS_MCP_WHITELIST } from '@/common/config/campusMcp';
import type { IMcpServer } from '@/common/config/storage';
import {
  buildCampusMcpServers,
  campusServiceScriptPath,
  findCampusRepoLayout,
  isCampusServerPathDrifted,
} from '@/process/utils/campusMcpBootstrap';

/**
 * 用临时目录伪造仓库树（每个白名单服务建出入口脚本，可只建一部分），
 * 验证仓库探测与注册条目构造不依赖真实机器上的仓库位置。
 */
const writeServiceEntry = (repoRoot: string, marker: string) => {
  const abs = path.join(repoRoot, ...marker.split('/'));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, '# fake entry\n', 'utf8');
};

let sandbox: string;
let repoRoot: string;

beforeAll(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'campus-bootstrap-'));
  repoRoot = path.join(sandbox, 'repo');
  for (const entry of CAMPUS_MCP_WHITELIST) {
    writeServiceEntry(repoRoot, entry.scriptMarker);
  }
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('findCampusRepoLayout', () => {
  it('walks up from a nested directory to the repo root', () => {
    const nested = path.join(repoRoot, 'packages', 'desktop', 'out', 'main');
    mkdirSync(nested, { recursive: true });
    expect(findCampusRepoLayout(nested)).toEqual({ repoRoot });
  });

  it('returns null when the markers are missing or the tree is too deep', () => {
    expect(findCampusRepoLayout(sandbox)).toBeNull();
    // 超过 MAX_WALK_UP(10) 层就放弃，避免在无关目录树上一直向上找
    const deep = path.join(sandbox, ...Array.from({ length: 12 }, (_, i) => `d${i}`));
    mkdirSync(deep, { recursive: true });
    expect(findCampusRepoLayout(deep)).toBeNull();
  });
});

describe('buildCampusMcpServers', () => {
  it('registers every whitelisted service found in the repo; key services disabled without a key', () => {
    const servers = buildCampusMcpServers({ repoRoot }, '');

    expect(servers.map((server) => server.name)).toEqual(CAMPUS_MCP_WHITELIST.map((entry) => entry.name));
    // 缺 Key：四个需要 Key 的服务禁用，课程规划（needsKey=false）保持启用
    expect(servers.map((server) => server.enabled)).toEqual([false, false, false, false, true]);
    for (const [index, server] of servers.entries()) {
      expect(server.builtin).toBe(true);
      if (server.transport.type !== 'stdio') throw new Error('expected stdio transport');
      expect(server.transport.args).toEqual([campusServiceScriptPath({ repoRoot }, CAMPUS_MCP_WHITELIST[index])]);
      expect(server.transport.env).toEqual({});
    }
  });

  it('enables every service and injects the key into env + original_json when a key is provided', () => {
    const servers = buildCampusMcpServers({ repoRoot }, '  sk-test  ');

    expect(servers).toHaveLength(CAMPUS_MCP_WHITELIST.length);
    for (const server of servers) {
      expect(server.enabled).toBe(true);
      if (server.transport.type !== 'stdio') throw new Error('expected stdio transport');
      expect(server.transport.env).toEqual({ DASHSCOPE_API_KEY: 'sk-test' });

      const parsed = JSON.parse(server.original_json || '{}') as {
        mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
      };
      expect(parsed.mcpServers[server.name as string].env.DASHSCOPE_API_KEY).toBe('sk-test');
      expect(parsed.mcpServers[server.name as string].args).toEqual(server.transport.args);
    }
  });

  it('skips services whose entry script is missing from the checkout', () => {
    const partialRoot = path.join(sandbox, 'partial-repo');
    writeServiceEntry(partialRoot, 'policy-search/server.py');
    writeServiceEntry(partialRoot, 'course-path-server/server.py');

    const servers = buildCampusMcpServers({ repoRoot: partialRoot }, '');
    expect(servers.map((server) => server.name)).toEqual(['policy_search', 'course_path_server']);
    expect(servers.map((server) => server.enabled)).toEqual([false, true]);
  });
});

describe('isCampusServerPathDrifted', () => {
  const makeFixture = () => {
    const desired = buildCampusMcpServers({ repoRoot }, '')[0];
    if (desired.transport.type !== 'stdio') throw new Error('expected stdio transport');
    const desiredArgs = desired.transport.args ?? [];

    const makeExisting = (overrides: Partial<IMcpServer> = {}): IMcpServer => ({
      id: 'id-existing',
      name: desired.name as string,
      enabled: false,
      created_at: 0,
      updated_at: 0,
      original_json: '{}',
      builtin: true,
      transport: { type: 'stdio', command: 'python', args: desiredArgs, env: {} },
      ...overrides,
    });

    return { desired, desiredArgs, makeExisting };
  };

  it('flags builtin entries whose command or args no longer match the repo', () => {
    const { desired, desiredArgs, makeExisting } = makeFixture();
    expect(isCampusServerPathDrifted(makeExisting(), desired)).toBe(false);
    expect(
      isCampusServerPathDrifted(
        makeExisting({
          transport: { type: 'stdio', command: 'python', args: ['D:/old/policy-search/server.py'], env: {} },
        }),
        desired
      )
    ).toBe(true);
    expect(
      isCampusServerPathDrifted(
        makeExisting({ transport: { type: 'stdio', command: 'py', args: desiredArgs, env: {} } }),
        desired
      )
    ).toBe(true);
  });

  it('never touches manually imported (non-builtin) entries', () => {
    const { desired, makeExisting } = makeFixture();
    expect(
      isCampusServerPathDrifted(
        makeExisting({ builtin: false, transport: { type: 'stdio', command: 'python', args: [], env: {} } }),
        desired
      )
    ).toBe(false);
  });
});
