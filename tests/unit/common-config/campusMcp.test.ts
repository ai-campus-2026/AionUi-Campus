import { describe, expect, it } from 'vitest';

import {
  CAMPUS_MCP_WHITELIST,
  collectCampusMcpServers,
  hasCampusEnvKey,
  isCampusMcp,
  withCampusApiKey,
} from '@/common/config/campusMcp';
import type { IMcpServer } from '@/common/config/storage';

const makeServer = (overrides: Partial<IMcpServer> & Pick<IMcpServer, 'name'>): IMcpServer => ({
  id: `id-${overrides.name}`,
  enabled: false,
  created_at: 0,
  updated_at: 0,
  original_json: '{}',
  transport: { type: 'stdio', command: 'python', args: [], env: {} },
  ...overrides,
});

describe('campusMcp whitelist', () => {
  it('locks the whitelist to the four confirmed campus services', () => {
    expect(CAMPUS_MCP_WHITELIST.map((entry) => entry.name)).toEqual([
      'policy_search',
      'rag',
      'contract-scan',
      'policy-comparison',
    ]);
    expect(CAMPUS_MCP_WHITELIST.map((entry) => entry.scriptMarker)).toEqual([
      'policy-search/server.py',
      'rag-mcp-server/server.py',
      'contract-guard/server.py',
      'policy-comparison/server.py',
    ]);
  });

  it('matches whitelisted campus MCPs by their registered names (case-insensitive)', () => {
    for (const name of ['policy_search', 'rag', 'contract-scan', 'policy-comparison']) {
      expect(isCampusMcp(makeServer({ name }))).toBe(true);
    }
    expect(isCampusMcp(makeServer({ name: 'Policy_Search' }))).toBe(true);
  });

  it('matches by server.py path marker when the entry name is custom', () => {
    // Windows 反斜杠路径（本机 policy_search / rag 的注册形态）
    expect(
      isCampusMcp(
        makeServer({
          name: 'my-custom-rag',
          transport: {
            type: 'stdio',
            command: 'python',
            args: ['D:\\AI-Campus-Workspace\\AionUi-Campus\\rag-mcp-server\\server.py'],
            env: {},
          },
        })
      )
    ).toBe(true);
    // 换 worktree / SSH 拷贝后的路径（contract-scan 模板配置里出现过）
    expect(
      isCampusMcp(
        makeServer({
          name: 'stage-copy',
          transport: {
            type: 'stdio',
            command: 'python',
            args: ['D:/AI-Campus-Workspace/AionUi-Campus-SSH/contract-guard/server.py'],
            env: {},
          },
        })
      )
    ).toBe(true);
    // 大小写与盘符差异不影响匹配
    expect(
      isCampusMcp(
        makeServer({
          name: 'lower-case',
          transport: { type: 'stdio', command: 'python', args: ['D:/Tools/POLICY-SEARCH/Server.py'], env: {} },
        })
      )
    ).toBe(true);
  });

  it('ignores unrelated python stdio MCPs (no name or marker match)', () => {
    expect(
      isCampusMcp(
        makeServer({
          name: 'my-python-helper',
          transport: { type: 'stdio', command: 'python', args: ['C:/tools/helper/server.py'], env: {} },
        })
      )
    ).toBe(false);
    // 前缀相近的目录不能误命中（policy-search-local-backup 不是白名单服务）
    expect(
      isCampusMcp(
        makeServer({
          name: 'policy-search-local-backup',
          transport: {
            type: 'stdio',
            command: 'python',
            args: ['D:/repo/policy-search-local-backup/server.py'],
            env: {},
          },
        })
      )
    ).toBe(false);
  });

  it('ignores non-stdio transports even when the name matches', () => {
    expect(isCampusMcp(makeServer({ name: 'rag', transport: { type: 'http', url: 'https://example.test/mcp' } }))).toBe(
      false
    );
  });

  it('collects only whitelisted servers and keeps the original order', () => {
    const servers = [
      makeServer({
        name: 'aionui-browser',
        transport: { type: 'stdio', command: 'node', args: ['/mock/browser.js'], env: {} },
      }),
      makeServer({ name: 'policy_search' }),
      makeServer({
        name: 'helper',
        transport: { type: 'stdio', command: 'python', args: ['C:/tools/helper.py'], env: {} },
      }),
      makeServer({ name: 'contract-scan' }),
      makeServer({
        name: 'chrome-devtools',
        transport: { type: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'], env: {} },
      }),
    ];

    expect(collectCampusMcpServers(servers).map((server) => server.name)).toEqual(['policy_search', 'contract-scan']);
  });

  it('hasCampusEnvKey only reports a non-empty DASHSCOPE_API_KEY', () => {
    expect(hasCampusEnvKey(makeServer({ name: 'rag' }))).toBe(false);
    expect(
      hasCampusEnvKey(
        makeServer({
          name: 'rag',
          transport: { type: 'stdio', command: 'python', args: [], env: { DASHSCOPE_API_KEY: '   ' } },
        })
      )
    ).toBe(false);
    expect(
      hasCampusEnvKey(
        makeServer({
          name: 'rag',
          transport: { type: 'stdio', command: 'python', args: [], env: { DASHSCOPE_API_KEY: 'sk-test' } },
        })
      )
    ).toBe(true);
  });

  it('withCampusApiKey injects the key, enables the server and rebuilds original_json', () => {
    const server = makeServer({
      name: 'rag',
      transport: {
        type: 'stdio',
        command: 'python',
        args: ['D:/repo/rag-mcp-server/server.py'],
        env: { EXISTING: '1' },
      },
    });

    const updated = withCampusApiKey(server, 'sk-test-key');

    expect(updated.enabled).toBe(true);
    if (updated.transport.type !== 'stdio') throw new Error('expected stdio transport');
    expect(updated.transport.env).toEqual({ EXISTING: '1', DASHSCOPE_API_KEY: 'sk-test-key' });

    const parsed = JSON.parse(updated.original_json) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    expect(parsed.mcpServers['rag'].env.DASHSCOPE_API_KEY).toBe('sk-test-key');
    expect(parsed.mcpServers['rag'].env.EXISTING).toBe('1');
  });

  it('withCampusApiKey returns non-stdio entries untouched', () => {
    const httpServer = makeServer({ name: 'rag', transport: { type: 'http', url: 'https://example.test/mcp' } });

    expect(withCampusApiKey(httpServer, 'sk-test-key')).toBe(httpServer);
  });
});
