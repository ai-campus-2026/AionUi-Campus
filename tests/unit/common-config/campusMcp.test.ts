import { describe, expect, it } from 'vitest';

import {
  CAMPUS_MCP_WHITELIST,
  collectCampusMcpServers,
  findStoredCampusApiKey,
  hasCampusEnvKey,
  isCampusMcp,
  requiresCampusApiKey,
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
  it('locks the whitelist to the five confirmed campus services', () => {
    expect(CAMPUS_MCP_WHITELIST.map((entry) => entry.name)).toEqual([
      'policy_search',
      'rag',
      'contract-scan',
      'policy-comparison',
      'course_path_server',
    ]);
    expect(CAMPUS_MCP_WHITELIST.map((entry) => entry.scriptMarker)).toEqual([
      'policy-search/server.py',
      'rag-mcp-server/server.py',
      'contract-guard/server.py',
      'policy-comparison/server.py',
      'course-path-server/server.py',
    ]);
    // 只有课程规划的核心功能不依赖 DashScope Key（缺 Key 不算故障、注册时不禁用）
    expect(CAMPUS_MCP_WHITELIST.map((entry) => entry.needsKey)).toEqual([true, true, true, true, false]);
    // course-path-server 的连字符别名（FastMCP 自报名 / 手动导入形态）
    expect(CAMPUS_MCP_WHITELIST.flatMap((entry) => entry.aliases ?? [])).toEqual(['course-path-server']);
  });

  it('matches whitelisted campus MCPs by their registered names (case-insensitive)', () => {
    for (const name of ['policy_search', 'rag', 'contract-scan', 'policy-comparison', 'course_path_server']) {
      expect(isCampusMcp(makeServer({ name }))).toBe(true);
    }
    expect(isCampusMcp(makeServer({ name: 'Policy_Search' }))).toBe(true);
    // course-path-server 的连字符别名同样命中
    expect(isCampusMcp(makeServer({ name: 'course-path-server' }))).toBe(true);
    expect(isCampusMcp(makeServer({ name: 'Course-Path-Server' }))).toBe(true);
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
    // course-path-server 目录（课程规划）
    expect(
      isCampusMcp(
        makeServer({
          name: 'curriculum',
          transport: {
            type: 'stdio',
            command: 'python',
            args: ['D:\\AI-Campus-Workspace\\AionUi-Campus\\course-path-server\\server.py'],
            env: {},
          },
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
    expect(
      requiresCampusApiKey(makeServer({ name: 'rag', transport: { type: 'http', url: 'https://example.test/mcp' } }))
    ).toBe(false);
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
      makeServer({ name: 'course-path-server' }),
      makeServer({
        name: 'chrome-devtools',
        transport: { type: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'], env: {} },
      }),
    ];

    expect(collectCampusMcpServers(servers).map((server) => server.name)).toEqual([
      'policy_search',
      'contract-scan',
      'course-path-server',
    ]);
  });

  it('requiresCampusApiKey is true only for the four key-dependent services', () => {
    for (const name of ['policy_search', 'rag', 'contract-scan', 'policy-comparison']) {
      expect(requiresCampusApiKey(makeServer({ name }))).toBe(true);
    }
    // 课程规划两种写法都不算「缺 Key」
    expect(requiresCampusApiKey(makeServer({ name: 'course_path_server' }))).toBe(false);
    expect(requiresCampusApiKey(makeServer({ name: 'course-path-server' }))).toBe(false);
    // 未命中白名单的条目一律 false（不要用它判断是否校园服务）
    expect(requiresCampusApiKey(makeServer({ name: 'my-python-helper' }))).toBe(false);
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

  it('findStoredCampusApiKey scans only whitelisted servers and returns the first non-empty key', () => {
    expect(findStoredCampusApiKey([])).toBe('');

    // 无关 Python MCP 里就算有同名变量也不能被误取
    expect(
      findStoredCampusApiKey([
        makeServer({
          name: 'my-python-helper',
          transport: { type: 'stdio', command: 'python', args: [], env: { DASHSCOPE_API_KEY: 'sk-other' } },
        }),
      ])
    ).toBe('');

    // 取第一个非空 Key（含首尾空白清理）
    expect(
      findStoredCampusApiKey([
        makeServer({ name: 'rag' }),
        makeServer({
          name: 'course_path_server',
          transport: { type: 'stdio', command: 'python', args: [], env: { DASHSCOPE_API_KEY: '  sk-course  ' } },
        }),
        makeServer({
          name: 'policy_search',
          transport: { type: 'stdio', command: 'python', args: [], env: { DASHSCOPE_API_KEY: 'sk-later' } },
        }),
      ])
    ).toBe('sk-course');
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
