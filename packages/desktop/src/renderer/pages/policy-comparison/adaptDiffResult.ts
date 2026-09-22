// ============================================================
// 政策对比 · MCP 结果解析器
// 把 MCP 工具返回的 JSON 适配成前端 PolicyDiffResult 结构。
// MCP 实际返回格式可能不同，这里做宽松解析：
//   1. 直接匹配 PolicyDiffResult 结构
//   2. 包裹在 { type: 'policy_diff', data: {...} } 里
//   3. 包裹在 { result: {...} } 里
// 解析失败返回 null，由调用方降级 mock。
// ============================================================

import type { PolicyDiffResult, PolicyChange, ChangeType } from './types';

/** 尝试从任意 JSON 中提取 PolicyDiffResult */
export function tryParsePolicyDiffResult(raw: unknown): PolicyDiffResult | null {
  if (!raw) return null;

  let obj: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  if (!obj || typeof obj !== 'object') return null;

  const candidates: unknown[] = [obj];
  const record = obj as Record<string, unknown>;
  if (record.data && typeof record.data === 'object') candidates.push(record.data);
  if (record.result && typeof record.result === 'object') candidates.push(record.result);
  if (record.payload && typeof record.payload === 'object') candidates.push(record.payload);

  for (const candidate of candidates) {
    const parsed = parseDirect(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function parseDirect(obj: unknown): PolicyDiffResult | null {
  if (!obj || typeof obj !== 'object') return null;
  const r = obj as Record<string, unknown>;

  const docRaw = r.document;
  if (!docRaw || typeof docRaw !== 'object') return null;
  const doc = docRaw as Record<string, unknown>;
  const name = typeof doc.name === 'string' ? doc.name : '';
  const oldVersion = typeof doc.oldVersion === 'string' ? doc.oldVersion : '旧版';
  const newVersion = typeof doc.newVersion === 'string' ? doc.newVersion : '新版';
  if (!name) return null;

  const changesRaw = r.changes;
  if (!Array.isArray(changesRaw)) return null;
  const changes: PolicyChange[] = [];
  for (const c of changesRaw) {
    const parsed = parseChange(c);
    if (parsed) changes.push(parsed);
  }
  if (changes.length === 0) return null;

  const summaryRaw = r.summary;
  let summary = { total: changes.length, modified: 0, added: 0, removed: 0 };
  if (summaryRaw && typeof summaryRaw === 'object') {
    const s = summaryRaw as Record<string, unknown>;
    summary = {
      total: typeof s.total === 'number' ? s.total : changes.length,
      modified: typeof s.modified === 'number' ? s.modified : changes.filter((c) => c.type === 'modified').length,
      added: typeof s.added === 'number' ? s.added : changes.filter((c) => c.type === 'added').length,
      removed: typeof s.removed === 'number' ? s.removed : changes.filter((c) => c.type === 'removed').length,
    };
  } else {
    summary.modified = changes.filter((c) => c.type === 'modified').length;
    summary.added = changes.filter((c) => c.type === 'added').length;
    summary.removed = changes.filter((c) => c.type === 'removed').length;
  }

  return { document: { name, oldVersion, newVersion }, summary, changes };
}

function parseChange(obj: unknown): PolicyChange | null {
  if (!obj || typeof obj !== 'object') return null;
  const c = obj as Record<string, unknown>;

  const changeId = typeof c.changeId === 'string' ? c.changeId : `change-${Math.random().toString(36).slice(2, 8)}`;
  const typeRaw = c.type;
  let type: ChangeType = 'modified';
  if (typeRaw === 'added' || typeRaw === 'add' || typeRaw === '新增') type = 'added';
  else if (typeRaw === 'removed' || typeRaw === 'remove' || typeRaw === 'deleted' || typeRaw === '删除')
    type = 'removed';
  else type = 'modified';

  const old = parseChangeContent(c.old);
  const n = parseChangeContent(c.new);

  let context: PolicyChange['context'] | undefined;
  if (c.context && typeof c.context === 'object') {
    const ctx = c.context as Record<string, unknown>;
    context = {
      before: Array.isArray(ctx.before) ? ctx.before.filter((x): x is string => typeof x === 'string') : undefined,
      after: Array.isArray(ctx.after) ? ctx.after.filter((x): x is string => typeof x === 'string') : undefined,
    };
  }

  const aiExplanation = typeof c.aiExplanation === 'string' ? c.aiExplanation : undefined;

  return { changeId, type, old, new: n, context, aiExplanation };
}

function parseChangeContent(obj: unknown): { section: string; content: string } | null {
  if (!obj || typeof obj !== 'object') return null;
  const c = obj as Record<string, unknown>;
  const section = typeof c.section === 'string' ? c.section : '';
  const content = typeof c.content === 'string' ? c.content : '';
  if (!section && !content) return null;
  return { section, content };
}
