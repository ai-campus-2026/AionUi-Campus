/**
 * 政策对比模块数据类型
 * 前端按此结构渲染，MCP 返回结构不同时在适配层转换
 */

export type ChangeType = 'modified' | 'added' | 'removed';

export interface ChangeContent {
  section: string;
  content: string;
}

export interface PolicyChange {
  changeId: string;
  type: ChangeType;
  old: ChangeContent | null;
  new: ChangeContent | null;
  context?: {
    before?: string[];
    after?: string[];
  };
  aiExplanation?: string;
}

export interface PolicyDiffSummary {
  total: number;
  modified: number;
  added: number;
  removed: number;
}

export interface PolicyDiffDocument {
  name: string;
  oldVersion: string;
  newVersion: string;
}

export interface PolicyDiffResult {
  document: PolicyDiffDocument;
  summary: PolicyDiffSummary;
  changes: PolicyChange[];
}

export type DiffLoadState = 'idle' | 'loading' | 'success' | 'error' | 'empty';

/** 历史对照记录（保存完整 Diff 快照，点击后直接渲染，不重新调用 MCP） */
export interface ComparisonHistoryRecord {
  id: string;
  docName: string;
  oldVersion: string;
  newVersion: string;
  oldFile?: string;
  newFile?: string;
  createdAt: string;
  summary?: {
    total: number;
    modified: number;
    added: number;
    removed: number;
  };
  /** 完整 Diff 快照（保存当时的 changes，历史不可变） */
  diffSnapshot?: PolicyDiffResult;
}

/** 选中的政策文件 */
export interface SelectedPolicyFile {
  name: string;
  version?: string;
  size?: number;
  type?: string;
  path?: string;
  source: 'upload' | 'knowledge';
  docId?: string;
}
