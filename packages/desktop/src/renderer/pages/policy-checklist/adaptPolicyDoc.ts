// ========== 申请清单页：适配层（拍平 / 分组 / 判定） ==========
// 数据来源：policy-search MCP 返回的 PolicyDoc。
// 本文件是唯一解析入口：后续接入真实 MCP 返回时，只需保证数据结构符合 PolicyDoc，页面代码不变。
import type {
  Answers,
  Board,
  ChecklistVerdict,
  EvidenceMap,
  PolicyCondition,
  PolicyDoc,
} from './types';

/** 拍平：requirements.xxx.conditions[] → 扁平条件数组 */
export function flattenConditions(doc: PolicyDoc): PolicyCondition[] {
  return Object.values(doc.requirements).flatMap((group) => group.conditions);
}

/** 按板块分组：veto / base / bonus / other（其余未知值忽略） */
export function groupByBoard(conditions: PolicyCondition[]): Record<Board, PolicyCondition[]> {
  const groups: Record<Board, PolicyCondition[]> = { veto: [], base: [], bonus: [], other: [] };
  for (const condition of conditions) {
    const board = groups[condition.board];
    if (board) board.push(condition);
  }
  return groups;
}

/** 数值比较：operator + value 判定用户输入是否达标 */
function compareValue(operator: string, input: number, threshold: number): boolean {
  switch (operator) {
    case '<=':
      return input <= threshold;
    case '>=':
      return input >= threshold;
    case '<':
      return input < threshold;
    case '>':
      return input > threshold;
    case '==':
    case '=':
      return input === threshold;
    default:
      // 未知比较符：不擅自判定，交给 agent
      return true;
  }
}

/** 单条基础门槛是否已达标（按 input_kind 分发，不做中文语义判断） */
export function isBaseMet(
  condition: PolicyCondition,
  value: Answers[string],
  evidence: EvidenceMap
): boolean {
  switch (condition.input_kind) {
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) return false;
      if (typeof condition.value !== 'number') return false;
      return compareValue(condition.operator, value, condition.value);
    }
    case 'yes_no':
      // base 的 yes_no：用户确认自己满足 → 选"是"即达标
      return value === true;
    case 'upload':
      // 材料提交类：上传即视为已提交
      return (evidence[condition.id]?.length ?? 0) > 0;
    case 'select':
    case 'range':
    case 'text':
      // 选择/文本类：非空即视为已提供（最终由 agent 判定）
      return value !== null && value !== undefined && value !== '';
    default:
      // none / 未知：不参与门槛计算
      return true;
  }
}

/**
 * 判定（与后端 §6 顺序一致：先短路后加权）
 * 1. VETO：任一命中 → disqualified，收起 base/bonus
 * 2. BASE：存在未达标 → incomplete
 * 3. 全部达标 → qualified（加分合计由 agent 终判返回，前端不臆造分值）
 */
export function evaluateChecklist(
  conditions: PolicyCondition[],
  answers: Answers,
  evidence: EvidenceMap
): ChecklistVerdict {
  const groups = groupByBoard(conditions);

  // 1. 一票否决短路
  const hitVetoes = groups.veto.filter((condition) => answers[condition.id] === true);
  if (hitVetoes.length > 0) {
    return {
      status: 'disqualified',
      hitVetoes,
      gaps: [],
      metCount: 0,
      baseTotal: groups.base.length,
      bonusTotal: groups.bonus.length,
      bonusProvided: groups.bonus.filter((condition) => (evidence[condition.id]?.length ?? 0) > 0).length,
    };
  }

  // 2. 基础门槛
  const gaps = groups.base.filter((condition) => !isBaseMet(condition, answers[condition.id], evidence));
  const metCount = groups.base.length - gaps.length;

  // 3. 加分项（只统计提供情况，分值依赖细则，不前端计算）
  const bonusProvided = groups.bonus.filter((condition) => (evidence[condition.id]?.length ?? 0) > 0).length;

  return {
    status: gaps.length > 0 ? 'incomplete' : 'qualified',
    hitVetoes: [],
    gaps,
    metCount,
    baseTotal: groups.base.length,
    bonusTotal: groups.bonus.length,
    bonusProvided,
  };
}
