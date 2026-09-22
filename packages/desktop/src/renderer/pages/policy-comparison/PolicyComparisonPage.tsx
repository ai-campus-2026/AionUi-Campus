import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ComparisonHistoryRecord, PolicyDiffResult, SelectedPolicyFile } from './types';
import { mockHistory } from './mockData';
import PolicyEntryView from './PolicyEntryView';
import PolicyDiffView from './PolicyDiffView';
import PolicyHistoryView from './PolicyHistoryView';
import './comparison.css';

const HISTORY_KEY = 'policy-comparison:history';

function loadHistory(): ComparisonHistoryRecord[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw) return JSON.parse(raw) as ComparisonHistoryRecord[];
  } catch {
    /* ignore */
  }
  // 首次进入：展示示例历史记录
  return mockHistory;
}

/**
 * 政策对比页面
 * - entry:   入口页（选择文件、确认、最近对照预览）
 * - history: 历史对照页（完整列表、搜索、筛选）
 * - diff:    政策变更对照页（左右双栏 Diff）
 */
const PolicyComparisonPage: React.FC = () => {
  const navigate = useNavigate();
  const [view, setView] = useState<'entry' | 'history' | 'diff'>('entry');
  const [diffResult, setDiffResult] = useState<PolicyDiffResult | null>(null);
  const [oldFile, setOldFile] = useState<SelectedPolicyFile | null>(null);
  const [newFile, setNewFile] = useState<SelectedPolicyFile | null>(null);
  const [history, setHistory] = useState<ComparisonHistoryRecord[]>(() => loadHistory());
  const [diffReturnView, setDiffReturnView] = useState<'entry' | 'history'>('entry');

  // 历史数据持久化
  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {
      /* ignore */
    }
  }, [history]);

  /** 从入口页开始对比 → 进入 Diff */
  const handleStartCompare = (result: PolicyDiffResult, oldF: SelectedPolicyFile, newF: SelectedPolicyFile) => {
    setDiffResult(result);
    setOldFile(oldF);
    setNewFile(newF);
    setDiffReturnView('entry');
    setView('diff');
  };

  const handleDeleteRecord = (recordId: string) => {
    setHistory((prev) => prev.filter((r) => r.id !== recordId));
  };

  /** 批量删除历史记录 */
  const handleBatchDeleteRecords = (recordIds: string[]) => {
    const idSet = new Set(recordIds);
    setHistory((prev) => prev.filter((r) => !idSet.has(r.id)));
  };

  /** 保存历史记录（带完整 Diff 快照） */
  const handleSaveHistory = (record: ComparisonHistoryRecord) => {
    setHistory((prev) => [record, ...prev].slice(0, 50));
  };

  /** 从历史记录进入 Diff（用保存的快照，不重新调用 MCP） */
  const handleSelectHistory = (record: ComparisonHistoryRecord) => {
    const result = record.diffSnapshot ?? {
      document: { name: record.docName, oldVersion: record.oldVersion, newVersion: record.newVersion },
      summary: record.summary ?? { total: 0, modified: 0, added: 0, removed: 0 },
      changes: [],
    };
    setDiffResult(result);
    setOldFile(record.oldFile ? { name: record.oldFile, version: record.oldVersion, source: 'knowledge' } : null);
    setNewFile(record.newFile ? { name: record.newFile, version: record.newVersion, source: 'knowledge' } : null);
    setDiffReturnView('history');
    setView('diff');
  };

  if (view === 'diff' && diffResult) {
    return (
      <PolicyDiffView
        result={diffResult}
        oldFile={oldFile}
        newFile={newFile}
        onBack={() => setView(diffReturnView)}
        onHome={() => navigate('/home')}
      />
    );
  }

  if (view === 'history') {
    return (
      <PolicyHistoryView
        history={history}
        onBack={() => setView('entry')}
        onNewCompare={() => setView('entry')}
        onSelectRecord={handleSelectHistory}
        onDelete={handleDeleteRecord}
        onBatchDelete={handleBatchDeleteRecords}
      />
    );
  }

  return (
    <PolicyEntryView
      history={history}
      onSaveHistory={handleSaveHistory}
      onStartCompare={handleStartCompare}
      onOpenHistory={() => setView('history')}
    />
  );
};

export default PolicyComparisonPage;
