// ========== 申请清单页：类型定义（对接队友《政策清单·前端对接文档》） ==========
// 原则：前端只按字段渲染，不做任何中文语义判断。所有板块/控件/判定由字段决定。

/** 板块：一票否决 / 基础门槛 / 加分项 / 其他须知 */
export type Board = 'veto' | 'base' | 'bonus' | 'other';

/** 控件类型：number/range/select/yes_no/text/upload/none */
export type InputKind = 'number' | 'range' | 'select' | 'yes_no' | 'text' | 'upload' | 'none';

/** 条件类型（后端语义，辅助展示用） */
export type ConditionType = 'hard' | 'scoring' | 'procedural' | 'qualitative';

/** 单条条件（字段名与后端返回严格一致，不重命名） */
export interface PolicyCondition {
  id: string;
  category: string;
  /** 卡片短标题 */
  item: string;
  /** 副标题/说明 */
  description: string;
  type: ConditionType;
  /** 所属板块 */
  board: Board;
  /** 控件类型 */
  input_kind: InputKind;
  /** 是否需要上传佐证 */
  requires_evidence: boolean;
  /** 是否有明确阈值 */
  quantifiable: boolean;
  /** select 控件的可选值（后端 annotator 后续补充；缺失时前端用通用 是/否 兜底） */
  options?: string[];
  /** 要求文案 */
  requirement: string | null;
  /** 比较符（number 校验用；真实 query_policy 返回可能缺失，缺失时前端不做阈值比较） */
  operator: string;
  /** 阈值 */
  value: number | null;
  /** 输入框后缀单位 */
  unit: string;
  /** 原文引用 */
  source_quote: string;
  /** 出处条款 */
  source_section: string;
  /** 后端判定状态（query_policy condition_matches[].match，渲染初始状态用） */
  backendMatch?: string;
  /** 后端返回的用户实际值（如 "前10.0%"） */
  userValue?: string;
  /** 后端返回的匹配详情 */
  matchDetail?: string;
  /**
   * 合并变体：同一 item 在 bonus 板出现多条（不同奖学金/条款的不同阈值）时，
   * 适配层合并为一条主条件，其余各档阈值放入 variants 供展示（判定仅用主条件）。
   */
  variants?: PolicyConditionVariant[];
}

/** 合并变体：同 item 的其余档位要求（仅展示用） */
export interface PolicyConditionVariant {
  description?: string;
  requirement?: string | null;
  source_section?: string;
  operator?: string;
  value?: number | null;
  unit?: string;
}

/** 按类别分组的条件集合（requirements.xxx） */
export interface PolicyRequirementGroup {
  label: string;
  conditions: PolicyCondition[];
}

/** 文档元信息 */
export interface PolicyDocMeta {
  doc_id: string;
  school: string;
  department: string;
  year: number;
  category: string;
  title: string;
  source_file: string;
  effective_date: string;
  tags: string[];
}

/** 顶层文档结构（policy-search 返回） */
export interface PolicyDoc {
  meta: PolicyDocMeta;
  raw_text?: string;
  requirements: Record<string, PolicyRequirementGroup>;
  important_dates?: Array<{ event: string; date: string | null; source_quote: string }>;
}

// ========== 用户作答状态 ==========

/** 用户答案：number 填数值 / yes_no 布尔 / upload 见 evidence / none 无 */
export type AnswerValue = number | string | boolean | null;
export type Answers = Record<string, AnswerValue>;

/** 上传的佐证材料（仅前端持有文件名，不真正上传） */
export interface EvidenceFile {
  name: string;
  size?: number;
}
export type EvidenceMap = Record<string, EvidenceFile[]>;

// ========== 判定结果 ==========

export type ChecklistStatus = 'disqualified' | 'incomplete' | 'qualified';

export interface ChecklistVerdict {
  /** 判定状态：不达标（命中一票否决）/ 待完善（有门槛未达）/ 符合 */
  status: ChecklistStatus;
  /** 命中的一票否决项 */
  hitVetoes: PolicyCondition[];
  /** 未达标的基础门槛 */
  gaps: PolicyCondition[];
  /** 基础门槛已达标数 */
  metCount: number;
  /** 基础门槛总数 */
  baseTotal: number;
  /** 加分项总数 */
  bonusTotal: number;
  /** 已提交材料的加分项数量 */
  bonusProvided: number;
}
