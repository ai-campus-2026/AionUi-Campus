// ============================================================
// 合同扫描 · 类型定义
// ============================================================

/** 合同类型 */
export type ContractType = 'auto' | 'rental' | 'internship' | 'labor' | 'nda' | 'other';

/** 风险等级 */
export type RiskLevel = 'high' | 'medium' | 'low' | 'ok';

/** 法规检查状态 */
export type StatuteStatus = 'violation' | 'ok' | 'unknown';

/** 证据来源 */
export type EvidenceSource = 'ai' | 'regex' | 'both';

/** 红旗风险项 */
export interface RedFlag {
  id: string;
  title: string;
  clauseQuote: string;
  explanation: string;
  suggestion: string;
  redline?: string;
  severity: 'high' | 'medium';
}

/** 一般警告 */
export interface Warning {
  id: string;
  title: string;
  explanation: string;
}

/** 做得好的条款 */
export interface GoodClause {
  id: string;
  title: string;
  explanation?: string;
}

/** 缺失的保护条款 */
export interface MissingProtection {
  id: string;
  title: string;
  explanation?: string;
}

/** 法规核查项 */
export interface StatuteCheck {
  id: string;
  ruleId: string;
  title: string;
  status: StatuteStatus;
  explanation: string;
  source: EvidenceSource;
  regulationRef?: string;
}

/** 法条依据 */
export interface LegalSource {
  ruleId: string;
  title: string;
  content: string;
}

/** 合同关键信息 */
export interface ContractMeta {
  title: string;
  parties?: string;
  contractType: ContractType;
  duration?: string;
  effectiveDate?: string;
}

/** 完整报告（前端消费的标准结构） */
export interface ContractReport {
  score: number;
  grade: string;
  summary: string;
  meta: ContractMeta;
  redFlags: RedFlag[];
  warnings: Warning[];
  goodClauses: GoodClause[];
  missingProtections: MissingProtection[];
  statuteChecks: StatuteCheck[];
  legalSources: LegalSource[];
  analysisDuration?: number;
  analysisId?: string;
}

/** 扫描状态 */
export type ScanStatus =
  | 'idle'
  | 'scanning'
  | 'success'
  | 'no_mcp'
  | 'timeout'
  | 'parse_failed'
  | 'error';
