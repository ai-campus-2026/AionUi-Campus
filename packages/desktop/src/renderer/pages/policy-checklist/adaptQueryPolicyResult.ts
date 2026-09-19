// ========== 申请清单页：query_policy 真实返回 → 前端渲染结构 适配层 ==========
// 队友 MCP 的 query_policy 返回 condition_matches（每条含 board/input_kind/requires_evidence/match），
// 与《政策清单·前端对接文档》一致。本文件把 results[0] 转成前端 PolicyCondition[] + 元信息 + 判定。
// 原则：只做字段映射与透传，不做任何中文语义判断；判定状态以后端 match 为准。
import type { Board, ChecklistVerdict, ConditionType, PolicyCondition, PolicyDocMeta } from './types';

/** 后端 condition_matches 单条原始结构（只声明前端用到的字段） */
export interface BackendConditionMatch {
  id?: string;
  item: string;
  requirement?: string | null;
  source_quote?: string;
  board?: string;
  input_kind?: string;
  requires_evidence?: boolean;
  match?: string;
  user_value?: string;
  detail?: string;
}

/** query_policy 单条政策结果（前端用到的字段） */
export interface BackendPolicyResult {
  policy_title?: string;
  policy_category?: string;
  overall_verdict?: string;
  veto_blocked?: boolean;
  triggered_vetoes?: Array<{ id?: string; item?: string; source_quote?: string }>;
  condition_matches?: BackendConditionMatch[];
  missing_info?: string[];
  needs_manual_review?: string[];
}

/** 适配后的清单页数据 */
export interface AdaptedChecklist {
  meta: PolicyDocMeta;
  conditions: PolicyCondition[];
  verdict: ChecklistVerdict;
  missingInfo: string[];
  needsManualReview: string[];
  vetoBlocked: boolean;
  triggeredVetoes: Array<{ id?: string; item?: string; source_quote?: string }>;
}

/** board 文本 → 前端 Board 枚举（未知值归入 other） */
function toBoard(b?: string): Board {
  if (b === 'veto' || b === 'base' || b === 'bonus' || b === 'other') return b;
  return 'other';
}

/** 条件类型：后端返回无 type，按板块推断仅供标签展示（判定不依赖此字段） */
function inferType(board: Board): ConditionType {
  if (board === 'bonus') return 'scoring';
  if (board === 'other') return 'qualitative';
  return 'hard';
}

/** 后端判定 → 前端"初始达标"语义（仅用于页面初始状态；用户补填后由输入驱动） */
export function isBackendMet(match?: string): boolean {
  return match === 'met';
}

/**
 * 适配：query_policy results[0] → 清单页数据
 * 真实返回不携带 operator/value/unit（阈值在 requirement 文案中），
 * 前端不做阈值比较（判定在后端），number 控件仅收集输入。
 */
export function adaptQueryPolicyResult(result: BackendPolicyResult): AdaptedChecklist {
  const meta: PolicyDocMeta = {
    doc_id: result.policy_category === 'scholarship' ? '重庆邮电_2016_001' : 'policy-query-result',
    school: '重庆邮电大学',
    department: '学生工作部（处）',
    year: 2026,
    category: result.policy_category ?? 'other',
    title: result.policy_title ?? '政策申请条件',
    source_file: 'query_policy 实时返回',
    effective_date: '—',
    tags: [result.policy_category === 'scholarship' ? '奖学金' : '政策'],
  };

  const conditions: PolicyCondition[] = (result.condition_matches ?? []).map((m): PolicyCondition => {
    const board = toBoard(m.board);
    return {
      id: m.id ?? `${m.item}-${Math.random().toString(36).slice(2, 8)}`,
      category: '',
      item: m.item,
      description: m.requirement ?? m.detail ?? '',
      type: inferType(board),
      board,
      input_kind: (['number', 'range', 'select', 'yes_no', 'text', 'upload', 'none'] as const).includes(m.input_kind as never)
        ? (m.input_kind as PolicyCondition['input_kind'])
        : 'none',
      requires_evidence: m.requires_evidence ?? false,
      quantifiable: m.input_kind === 'number',
      requirement: m.requirement ?? null,
      operator: '',
      value: null,
      unit: '',
      source_quote: m.source_quote ?? '',
      source_section: '',
      backendMatch: m.match,
      userValue: m.user_value,
      matchDetail: m.detail,
    };
  });

  // 判定（以后端 overall_verdict 为准；映射到前端三态）
  const status: ChecklistVerdict['status'] =
    result.overall_verdict === 'disqualified'
      ? 'disqualified'
      : result.overall_verdict === 'likely_eligible' || result.overall_verdict === 'possibly_eligible'
        ? 'qualified'
        : 'incomplete';

  const vetoes = conditions.filter((c) => c.board === 'veto');
  const base = conditions.filter((c) => c.board === 'base');
  const bonus = conditions.filter((c) => c.board === 'bonus');
  const hitVetoes = vetoes.filter((c) => c.backendMatch === 'violated');

  const verdict: ChecklistVerdict = {
    status,
    hitVetoes,
    gaps: base.filter((c) => !isBackendMet(c.backendMatch)),
    metCount: base.filter((c) => isBackendMet(c.backendMatch)).length,
    baseTotal: base.length,
    bonusTotal: bonus.length,
    bonusProvided: bonus.filter((c) => c.backendMatch === 'met').length,
  };

  return {
    meta,
    conditions,
    verdict,
    missingInfo: result.missing_info ?? [],
    needsManualReview: result.needs_manual_review ?? [],
    vetoBlocked: result.veto_blocked ?? false,
    triggeredVetoes: result.triggered_vetoes ?? [],
  };
}
