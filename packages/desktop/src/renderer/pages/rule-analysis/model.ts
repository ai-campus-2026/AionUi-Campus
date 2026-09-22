// ============================================================
// 政策解读工作台 · 数据模型（六个核心概念）
//   UserProfile    —— 长期个人资料（不属于任何一份报告）
//   AnalysisTask   —— 持续存在的政策分析目标（无「已完成」状态）
//   Conversation   —— 该任务的补充信息交互（不是独立聊天页）
//   ReportSnapshot —— 不可变的历史分析结果（V1→V2→V3…只增不改）
//   PolicyVersion  —— 报告生成时锁定的政策版本
//   MatchResult    —— 具体条件的匹配状态（满足 / 待确认 / 未满足）
// 核心原则：分析永不结束，报告永远是快照。
// ============================================================

import type {
  CampusRuleToolResult,
  ConditionGroup as McpConditionGroup,
  ConditionRow as McpConditionRow,
} from '@renderer/components/campus-rule/types';

// ---------- MCP 数据驱动的条件行（扩展后端控件字段） ----------
/** 后端指定的控件类型（前端只渲染，不做语义判断） */
export interface RowControl {
  type: 'text' | 'input' | 'number' | 'select' | 'date';
  options?: string[];
  placeholder?: string;
  fieldKey?: string;
}

/** MCP 条件行（兼容后端可能返回的 control 字段和 sourceFile） */
export type AnalysisConditionRow = McpConditionRow & {
  control?: RowControl;
  category?: string;
  /** 来源政策文件（前端引擎转换时带入，MCP 原始数据可能没有） */
  sourceFile?: string;
};

/** MCP 条件分组（板块） */
export type AnalysisConditionGroup = Omit<McpConditionGroup, 'rows'> & { rows: AnalysisConditionRow[] };

/** 从 MCP 结果派生的汇总统计（纯计数，不做判断） */
export interface AnalysisSummary {
  met: number;
  missing: number;
  notMet: number;
  review: number;
  total: number;
}

/** MCP 解读结果快照（存入任务和报告） */
export interface AnalysisSnapshot {
  /** MCP 原始结果（前端只做字段渲染） */
  mcp: CampusRuleToolResult;
  /** 板块分组（从 mcp.conditionGroups 或 conditionTable 派生） */
  groups: AnalysisConditionGroup[];
  /** 汇总统计（从 rows 纯计数） */
  summary: AnalysisSummary;
  /** 生成时间 */
  createdAt: string;
}

// ---------- 前端引擎 → MCP 格式转换（过渡期兼容，最终完全由 MCP 驱动） ----------
/** 把旧引擎 MatchResult 转成 MCP ConditionRow（state→match，conditionId→id） */
export function matchResultToRow(r: MatchResult): AnalysisConditionRow {
  return {
    id: r.conditionId,
    item: r.item,
    match: r.state === 'missing' ? 'missing_info' : r.state,
    userValue: r.userValue,
    requirement: r.requirement,
    sourceQuote: r.sourceQuote,
    sourceFile: r.sourceFile,
  };
}

/** 把旧引擎 ConditionGroup[] 转成 MCP AnalysisConditionGroup[] */
export function engineGroupsToMcp(groups: ConditionGroup[]): AnalysisConditionGroup[] {
  return groups.map((g) => ({
    id: g.id,
    label: g.label,
    rows: g.rows.map(matchResultToRow),
  }));
}

// ---------- 从 MCP 结果提取分组（前端不做判断，只取字段） ----------
export function groupsFromMcp(result: CampusRuleToolResult): AnalysisConditionGroup[] {
  if (result.conditionGroups && result.conditionGroups.length > 0) {
    return result.conditionGroups as AnalysisConditionGroup[];
  }
  if (result.conditionTable && result.conditionTable.length > 0) {
    const rows = result.conditionTable as AnalysisConditionRow[];
    // 如果每条有 category 字段，按 category 分组（字段渲染，不做语义判断）
    const hasCategory = rows.some((r) => r.category && r.category.trim());
    if (hasCategory) {
      const groupMap = new Map<string, AnalysisConditionRow[]>();
      for (const row of rows) {
        const label = row.category?.trim() || '其他';
        if (!groupMap.has(label)) groupMap.set(label, []);
        groupMap.get(label)!.push(row);
      }
      return Array.from(groupMap.entries()).map(([label, groupRows], i) => ({
        id: 'group-' + i,
        label,
        rows: groupRows,
      }));
    }
    return [{ id: 'all', label: '全部条件', rows }];
  }
  return [];
}

// ---------- 从分组纯计数汇总（不做任何语义判断） ----------
export function summaryFromGroups(groups: AnalysisConditionGroup[]): AnalysisSummary {
  let met = 0,
    missing = 0,
    notMet = 0,
    review = 0;
  for (const g of groups) {
    for (const r of g.rows) {
      if (r.match === 'met') met++;
      else if (r.match === 'missing_info') missing++;
      else if (r.match === 'not_met') notMet++;
      else if (r.match === 'needs_manual_review') review++;
    }
  }
  return { met, missing, notMet, review, total: met + missing + notMet + review };
}

// ---------- 条件匹配状态（三态 + UI 过渡态） ----------
export type ConditionState = 'met' | 'missing' | 'not_met';
/** analyzing 仅存在于 UI 层（重新分析过程中的瞬态） */
export type UiConditionState = ConditionState | 'analyzing';

// ---------- 我的信息 ----------
export type ProfileCategory = 'basic' | 'academic' | 'english' | 'performance' | 'awards' | 'research' | 'other';

export interface ProfileCategoryMeta {
  key: ProfileCategory;
  label: string;
  hint: string;
}

export const PROFILE_CATEGORIES: ProfileCategoryMeta[] = [
  { key: 'basic', label: '基础信息', hint: '学籍、年级、专业等长期身份信息' },
  { key: 'academic', label: '学业成绩', hint: 'GPA、专业排名、挂科记录等' },
  { key: 'english', label: '英语成绩', hint: 'CET-4 / CET-6 等语言成绩' },
  { key: 'performance', label: '综合表现', hint: '综合测评、志愿服务、学术活动等' },
  { key: 'awards', label: '获奖经历', hint: '奖学金、荣誉称号、竞赛奖项等' },
  { key: 'research', label: '科研经历', hint: '论文、科研项目、专利等' },
  { key: 'other', label: '其他信息', hint: '推荐信、处分记录、申请材料等' },
];

export interface ProfileField {
  key: string;
  label: string;
  category: ProfileCategory;
  value: string;
  updatedAt: string;
}

export interface UserProfile {
  fields: Record<string, ProfileField>;
  updatedAt: string;
}

// ---------- 政策版本 ----------
export interface PolicyVersion {
  id: string;
  title: string;
  /** 如 2026版 */
  version: string;
  publishedAt: string;
  /** 是否为当前最新政策 */
  latest: boolean;
}

// ---------- 条件定义与匹配结果 ----------
export interface ConditionDef {
  id: string;
  item: string;
  /** 所属分组 id（如 g-basic） */
  group: string;
  requirement: string;
  /** 政策原文依据 */
  sourceQuote: string;
  sourceFile: string;
  /** 依赖的「我的信息」字段 key */
  dependsOn: string[];
}

export interface MatchResult {
  conditionId: string;
  item: string;
  state: ConditionState;
  userValue: string;
  requirement: string;
  sourceQuote: string;
  sourceFile: string;
}

export interface ConditionGroup {
  id: string;
  label: string;
  rows: MatchResult[];
}

export interface MatchSummary {
  met: number;
  missing: number;
  notMet: number;
}

// ---------- 分析任务 ----------
export interface AnalysisTask {
  id: string;
  /** 目标 key（national_scholarship / tuimian / sanhao） */
  goalKey: string;
  title: string;
  policyVersionId: string;
  createdAt: string;
  updatedAt: string;
  /** 最近一次 MCP 解读结果（分组），永不删除、只被新结果替换 */
  current: AnalysisConditionGroup[];
}

// ---------- 对话（补充信息交互） ----------
export type ConversationMessageKind = 'user' | 'system_info' | 'system_goal' | 'system_confirm' | 'assistant';

export interface ConversationMessage {
  id: string;
  kind: ConversationMessageKind;
  text: string;
  createdAt: string;
  /** 系统识别出的字段信息（供 UI 展示结构化反馈） */
  meta?: { fieldKey: string; label: string; value: string; affectedConditionIds: string[] };
}

export interface Conversation {
  id: string;
  taskId: string;
  messages: ConversationMessage[];
}

// ---------- 报告快照（不可变） ----------
export interface ProfileSnapshotEntry {
  label: string;
  value: string;
}

export interface ReportChange {
  /** 如「新增信息」「结果变化」 */
  label: string;
  /** 如 'CET-6：523分' */
  text: string;
}

export interface ReportSnapshot {
  id: string;
  /** 1 → V1 */
  version: number;
  createdAt: string;
  analysisTaskId: string;
  /** 生成时锁定的个人信息快照 */
  profileSnapshot: ProfileSnapshotEntry[];
  /** 生成时锁定的政策版本（报告不可随政策更新而变化） */
  policyVersion: PolicyVersion;
  matchResults: AnalysisConditionGroup[];
  summary: MatchSummary;
  /** 相对上一版的本次变化 */
  changes: ReportChange[];
}

// ---------- 工作台整体状态 ----------
/** entry = 政策解读首页（提问入口）；analysis = 已创建/恢复任务后的分析工作台 */
export type ViewName = 'entry' | 'analysis' | 'reports' | 'report' | 'profile';

export interface WorkbenchState {
  profile: UserProfile;
  policyVersions: PolicyVersion[];
  tasks: AnalysisTask[];
  conversations: Conversation[];
  reports: ReportSnapshot[];
}
