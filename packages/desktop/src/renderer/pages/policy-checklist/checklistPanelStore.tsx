// ========== 政策清单右侧面板：全局状态 ==========
// 触发：对话中 AI 调用 query_policy 工具（category 命中奖学金/推免）→ openChecklist
// 渲染：Layout 级预览区 / ChatLayout 预览区读取 docKey，显示清单面板替代文件预览
// 实时数据：对话工具消息解析出的 query_policy results[0] 原始返回（rawResult），
// 面板/页面拿到后经 adaptQueryPolicyResult 渲染，实现"每次问答实时更新"。
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { BackendPolicyResult } from './adaptQueryPolicyResult';

/** 与知识库 category 对齐的清单文档键（scholarship/postgraduate_recommendation 由对话 query_policy 触发） */
export type ChecklistDocKey = 'scholarship' | 'postgraduate_recommendation';

/**
 * 对话预填提示：从用户问题原文解析出的结构化信息，按条件 item 名（如
 * "学业成绩排名"）映射到清单输入项。清单打开时自动填入尚未手填的项。
 */
export type ChecklistHints = Record<string, number | string | boolean>;

/** 工作台"查询文件"多选的值：知识库真实文件标识（doc_id，与"规则动态"同源） */
export type SelectedPolicyFile = string;

interface PolicyChecklistPanelState {
  /** 当前要展示的清单文档；null = 不显示面板（没有问题时面板不出现） */
  docKey: ChecklistDocKey | null;
  /** 最近一次打开清单时的对话预填提示（与 docKey 一起更新） */
  hints: ChecklistHints;
  /** 最近一次 query_policy 调用的完整原始返回 results 数组（实时数据源；null = 尚未触发查询） */
  rawResults: BackendPolicyResult[] | null;
  /** 工作台"查询文件"多选：知识库真实文件标题列表（与规则动态同源；渲染时按标题过滤后端返回） */
  selectedDocs: SelectedPolicyFile[];
  setSelectedDocs: (docs: SelectedPolicyFile[]) => void;
  openChecklist: (key: ChecklistDocKey, hints?: ChecklistHints, rawResults?: BackendPolicyResult[] | null) => void;
  closeChecklist: () => void;
}

const PolicyChecklistPanelContext = createContext<PolicyChecklistPanelState | null>(null);

export const PolicyChecklistPanelProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [docKey, setDocKey] = useState<ChecklistDocKey | null>(null);
  const [hints, setHints] = useState<ChecklistHints>({});
  const [rawResults, setRawResults] = useState<BackendPolicyResult[] | null>(null);
  const [selectedDocs, setSelectedDocsState] = useState<SelectedPolicyFile[]>([]);

  const setSelectedDocs = useCallback((docs: SelectedPolicyFile[]) => {
    setSelectedDocsState(docs);
  }, []);

  const openChecklist = useCallback(
    (key: ChecklistDocKey, nextHints?: ChecklistHints, nextRawResults?: BackendPolicyResult[] | null) => {
      setDocKey(key);
      setHints(nextHints ?? {});
      setRawResults(nextRawResults ?? null);
    },
    []
  );

  const closeChecklist = useCallback(() => {
    setDocKey(null);
    setHints({});
    setRawResults(null);
  }, []);

  const value = useMemo(
    () => ({ docKey, hints, rawResults, selectedDocs, setSelectedDocs, openChecklist, closeChecklist }),
    [docKey, hints, rawResults, selectedDocs, setSelectedDocs, openChecklist, closeChecklist]
  );

  return (
    <PolicyChecklistPanelContext.Provider value={value}>{children}</PolicyChecklistPanelContext.Provider>
  );
};

export const usePolicyChecklistPanel = (): PolicyChecklistPanelState => {
  const context = useContext(PolicyChecklistPanelContext);
  if (!context) {
    throw new Error('usePolicyChecklistPanel must be used within PolicyChecklistPanelProvider');
  }
  return context;
};
