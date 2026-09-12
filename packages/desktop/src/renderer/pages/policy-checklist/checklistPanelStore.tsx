// ========== 政策清单右侧面板：全局状态 ==========
// 触发：对话中 AI 调用 query_policy 工具（category 命中奖学金/推免）→ openChecklist
// 渲染：Layout 级预览区 / ChatLayout 预览区读取 docKey，显示清单面板替代文件预览
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

/** 与知识库 category 对齐的清单文档键（目前映射到 mock 文档；接真实 MCP 后换运行时数据） */
export type ChecklistDocKey = 'scholarship' | 'postgraduate_recommendation';

/**
 * 对话预填提示：从用户问题原文解析出的结构化信息，按条件 item 名（如
 * "学业成绩排名"）映射到清单输入项。清单打开时自动填入尚未手填的项。
 */
export type ChecklistHints = Record<string, number | string | boolean>;

interface PolicyChecklistPanelState {
  /** 当前要展示的清单文档；null = 不显示面板 */
  docKey: ChecklistDocKey | null;
  /** 最近一次打开清单时的对话预填提示（与 docKey 一起更新） */
  hints: ChecklistHints;
  openChecklist: (key: ChecklistDocKey, hints?: ChecklistHints) => void;
  closeChecklist: () => void;
}

const PolicyChecklistPanelContext = createContext<PolicyChecklistPanelState | null>(null);

export const PolicyChecklistPanelProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [docKey, setDocKey] = useState<ChecklistDocKey | null>(null);
  const [hints, setHints] = useState<ChecklistHints>({});

  const openChecklist = useCallback((key: ChecklistDocKey, nextHints?: ChecklistHints) => {
    setDocKey(key);
    setHints(nextHints ?? {});
  }, []);

  const closeChecklist = useCallback(() => {
    setDocKey(null);
    setHints({});
  }, []);

  const value = useMemo(
    () => ({ docKey, hints, openChecklist, closeChecklist }),
    [docKey, hints, openChecklist, closeChecklist]
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
