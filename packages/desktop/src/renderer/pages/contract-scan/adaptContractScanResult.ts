// ============================================================
// 合同扫描 · MCP 结果适配层
// ============================================================

import type { ContractReport, RedFlag, Warning, GoodClause, MissingProtection, StatuteCheck, LegalSource, ContractType } from './types';

/** MCP 返回的原始结构（宽松定义） */
interface RawContractScanResult {
  // 外层信封
  ok?: boolean;
  data?: RawContractData;
  warnings?: string[];
  meta?: {
    request_id?: string;
    elapsed_ms?: number;
  };
  // 直接数据
  fairness_score?: number;
  fairness_grade?: string;
  grade?: string;
  summary?: string;
  parties?: string | string[];
  contract_type?: string;
  duration?: string;
  effective_date?: string;
  red_flags?: Array<{
    title?: string;
    clause?: string;
    quote?: string;
    explanation?: string;
    suggestion?: string;
    redline?: string;
    severity?: string;
  }>;
  warnings_list?: Array<{ title?: string; explanation?: string; quote?: string; suggestion?: string; redline?: string; severity?: string }>;
  good_clauses?: Array<{ title?: string; clause?: string; explanation?: string }>;
  missing_protections?: Array<string | { title?: string; explanation?: string }>;
  statute_checks?: Array<{
    rule_id?: string;
    title?: string;
    basis?: string;
    status?: string;
    detail?: string;
    explanation?: string;
    quote?: string;
    source?: string;
    regulation_ref?: string;
  }>;
  sources?: Array<{
    rule_id?: string;
    document?: string;
    section?: string;
    text?: string;
    title?: string;
    content?: string;
  }>;
  legal_sources?: Array<{
    rule_id?: string;
    title?: string;
    content?: string;
  }>;
  mermaid_chart?: string | null;
  analysis_duration?: number;
  analysis_id?: string;
  elapsed_ms?: number;
  request_id?: string;
}

interface RawContractData {
  fairness_score?: number;
  fairness_grade?: string;
  summary?: string;
  parties?: string | string[];
  contract_type?: string;
  red_flags?: Array<{
    title?: string;
    clause?: string;
    quote?: string;
    explanation?: string;
    suggestion?: string;
    redline?: string;
    severity?: string;
  }>;
  warnings?: Array<{ title?: string; explanation?: string; quote?: string; suggestion?: string; redline?: string; severity?: string }>;
  good_clauses?: Array<{ title?: string; clause?: string; explanation?: string }>;
  missing_protections?: Array<string | { title?: string; explanation?: string }>;
  statute_checks?: Array<{
    rule_id?: string;
    title?: string;
    basis?: string;
    status?: string;
    detail?: string;
    quote?: string;
    source?: string;
  }>;
  sources?: Array<{
    rule_id?: string;
    document?: string;
    section?: string;
    text?: string;
  }>;
  fairness_grade?: string;
  mermaid_chart?: string | null;
  key_terms?: string[];
}

function normalizeType(t?: string): ContractType {
  if (!t) return 'auto';
  const s = t.toLowerCase();
  if (s.includes('rent') || s.includes('租')) return 'rental';
  if (s.includes('intern') || s.includes('实习')) return 'internship';
  if (s.includes('labor') || s.includes('劳动') || s.includes('employment')) return 'labor';
  if (s.includes('nda') || s.includes('保密')) return 'nda';
  return 'other';
}

/** 尝试从 MCP 原始输出中解析合同扫描报告 */
export function tryParseContractScanResult(raw: unknown): ContractReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const envelope = raw as RawContractScanResult;

  // 处理外层信封格式：{ ok: true, data: { ... } }
  let data: RawContractData;
  if (envelope.data && typeof envelope.data === 'object') {
    // 检查 ok 是否为 false
    if (envelope.ok === false) {
      return null;
    }
    data = envelope.data;
  } else {
    // 直接就是数据格式
    data = envelope as unknown as RawContractData;
  }

  // 检查是否有有效数据
  if (typeof data.fairness_score !== 'number' && !data.summary) return null;

  const redFlags: RedFlag[] = (data.red_flags ?? []).map((rf, i) => ({
    id: `rf-${i}`,
    title: rf.title ?? '未命名风险',
    clauseQuote: rf.quote ?? rf.clause ?? '',
    clause: rf.clause ?? '',
    explanation: rf.explanation ?? '',
    suggestion: rf.suggestion ?? '',
    redline: rf.redline,
    severity: rf.severity === 'red' || rf.severity === 'high' ? 'high' : 'medium',
  }));

  const warnings: Warning[] = (data.warnings ?? []).map((w, i) => ({
    id: `w-${i}`,
    title: w.title ?? '一般隐患',
    explanation: w.explanation ?? '',
  }));

  const goodClauses: GoodClause[] = (data.good_clauses ?? []).map((g, i) => ({
    id: `gc-${i}`,
    title: g.title ?? '保护性条款',
    clause: g.clause,
    explanation: g.explanation,
  }));

  const missingProtections: MissingProtection[] = (data.missing_protections ?? []).map((m, i) => {
    if (typeof m === 'string') {
      return { id: `mp-${i}`, title: m, explanation: undefined };
    }
    return { id: `mp-${i}`, title: m.title ?? '缺失条款', explanation: m.explanation };
  });

  const statuteChecks: StatuteCheck[] = (data.statute_checks ?? []).map((sc, i) => ({
    id: `sc-${i}`,
    ruleId: sc.rule_id ?? `rule-${i}`,
    title: sc.title ?? '法规检查',
    status: (sc.status as StatuteCheck['status']) ?? 'unknown',
    explanation: sc.detail ?? sc.explanation ?? '',
    source: (sc.source as StatuteCheck['source']) ?? 'regex',
    regulationRef: sc.basis ?? sc.regulation_ref,
    quote: sc.quote,
  }));

  const legalSources: LegalSource[] = (data.sources ?? []).map((ls) => ({
    ruleId: ls.rule_id ?? '',
    title: ls.document && ls.section ? `${ls.document} ${ls.section}` : ls.title ?? '',
    content: ls.text ?? ls.content ?? '',
  }));

  return {
    score: Math.round(data.fairness_score ?? 50),
    grade: data.fairness_grade ?? data.grade ?? 'B',
    summary: data.summary ?? '',
    meta: {
      title: '合同分析报告',
      parties: Array.isArray(data.parties) ? data.parties.join('、') : data.parties,
      contractType: normalizeType(data.contract_type),
      duration: undefined,
      effectiveDate: undefined,
    },
    redFlags,
    warnings,
    goodClauses,
    missingProtections,
    statuteChecks,
    legalSources,
    analysisDuration: envelope.meta?.elapsed_ms ? envelope.meta.elapsed_ms / 1000 : (envelope.elapsed_ms ? envelope.elapsed_ms / 1000 : undefined),
    analysisId: envelope.meta?.request_id ?? envelope.request_id,
  };
}
