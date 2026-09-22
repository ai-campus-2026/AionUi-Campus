// ============================================================
// 政策解读工作台 · 数据引擎（mock 实现）
// 包含：个人信息字段定义、政策条件库、匹配引擎、信息抽取器、
//       目标意图识别、种子数据。
// 结构上所有数据访问都经过 store.ts，未来接真实 API 时仅需替换 store 层。
// ============================================================

import { engineGroupsToMcp } from './model';
import type {
  AnalysisTask,
  ConditionDef,
  ConditionGroup,
  ConditionState,
  Conversation,
  MatchResult,
  MatchSummary,
  PolicyVersion,
  ProfileCategory,
  ProfileField,
  ReportChange,
  ReportSnapshot,
  UserProfile,
  WorkbenchState,
} from './model';

// ---------- 工具 ----------
export const todayStr = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

let seq = 0;
export const makeId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

// ---------- 我的信息 · 字段定义 ----------
export interface FieldDef {
  key: string;
  label: string;
  category: ProfileCategory;
  hint: string;
}

export const FIELD_DEFS: FieldDef[] = [
  { key: 'basic.enrolled', label: '学籍状态', category: 'basic', hint: '例如：全日制在读本科生' },
  { key: 'basic.grade', label: '年级', category: 'basic', hint: '例如：大三' },
  { key: 'basic.major', label: '专业', category: 'basic', hint: '例如：软件工程' },
  { key: 'academic.gpa', label: 'GPA', category: 'academic', hint: '例如：3.72' },
  { key: 'academic.rank', label: '专业排名', category: 'academic', hint: '例如：12/120' },
  { key: 'academic.fail', label: '挂科记录', category: 'academic', hint: '例如：无' },
  { key: 'academic.courseMin', label: '课程成绩', category: 'academic', hint: '例如：无不及格课程' },
  { key: 'english.cet4', label: 'CET-4', category: 'english', hint: '例如：542' },
  { key: 'english.cet6', label: 'CET-6', category: 'english', hint: '例如：523' },
  { key: 'performance.comprehensive', label: '综合测评', category: 'performance', hint: '例如：88' },
  { key: 'performance.volunteer', label: '志愿服务', category: 'performance', hint: '例如：32小时' },
  { key: 'performance.activity', label: '学术活动', category: 'performance', hint: '例如：参加校级学术讲座' },
  { key: 'awards.awards', label: '获奖经历', category: 'awards', hint: '例如：校优秀学生干部' },
  { key: 'research.research', label: '科研经历', category: 'research', hint: '例如：省级大创项目结题' },
  { key: 'other.discipline', label: '处分记录', category: 'other', hint: '例如：无' },
  { key: 'other.recommendation', label: '推荐信', category: 'other', hint: '例如：有（1封）' },
  { key: 'other.materials', label: '申请材料', category: 'other', hint: '例如：齐全' },
];

const fieldDefMap = new Map(FIELD_DEFS.map((f) => [f.key, f]));
export const fieldLabel = (key: string): string => fieldDefMap.get(key)?.label ?? key;

/**
 * 从条件名称推断对应的「我的信息」字段 key。
 * 用于 MCP 返回 userValue 时自动同步到个人资料。
 * 匹配不到时返回 null（不做强制映射，避免写错字段）。
 */
export function guessFieldKey(item: string): string | null {
  const t = item.replace(/\s/g, '').toLowerCase();
  const rules: { key: string; match: RegExp }[] = [
    { key: 'academic.gpa', match: /gpa|绩点|平均学分|平均成绩/ },
    { key: 'academic.rank', match: /专业排名|排名|名次/ },
    { key: 'academic.fail', match: /挂科|不及格|重修/ },
    { key: 'academic.courseMin', match: /课程成绩|单科成绩|最低分/ },
    { key: 'english.cet4', match: /cet[-_]?4|四级|英语四级/ },
    { key: 'english.cet6', match: /cet[-_]?6|六级|英语六级/ },
    { key: 'performance.comprehensive', match: /综合测评|综测|综合素质/ },
    { key: 'performance.volunteer', match: /志愿|公益|志愿服务/ },
    { key: 'performance.activity', match: /学术活动|社团活动|社会实践/ },
    { key: 'awards.awards', match: /获奖|奖项|荣誉|竞赛奖/ },
    { key: 'research.research', match: /科研|论文|专利|大创|课题/ },
    { key: 'basic.enrolled', match: /学籍|在读|入学|全日制/ },
    { key: 'basic.grade', match: /年级|大一|大二|大三|大四/ },
    { key: 'basic.major', match: /专业|学院/ },
    { key: 'other.discipline', match: /处分|违纪|记过/ },
    { key: 'other.recommendation', match: /推荐信|导师推荐/ },
    { key: 'other.materials', match: /申请材料|材料齐全/ },
  ];
  for (const r of rules) {
    if (r.match.test(t)) return r.key;
  }
  return null;
}

/**
 * 为不在预设映射里的条件生成稳定的动态 fieldKey。
 * 用条件名称的简单 hash 生成，保证同一条件名称每次生成相同的 key。
 * 这样 MCP 返回任何新条件，都能自动在「我的信息」里生成对应卡片。
 */
export function dynamicFieldKey(item: string): string {
  let hash = 0;
  const str = item.trim();
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return `dynamic_${Math.abs(hash)}`;
}

// ---------- 政策条件库 ----------
export interface ConditionRule extends ConditionDef {
  /** 判断提供的字段值是否满足要求 */
  judge: (value: string) => boolean;
}

const UNPROVIDED = '未提供';
const hasValue = (v: string) => v !== UNPROVIDED && v.trim() !== '';
const no = (v: string) => v.trim().startsWith('无') || v === '未提供';
const gteNum = (v: string, n: number) => hasValue(v) && Number.parseFloat(v) >= n;
const ratioOk = (v: string, max: number) => {
  const m = v.match(/(\d+)\s*\/\s*(\d+)/);
  return !!m && Number(m[1]) / Number(m[2]) <= max;
};
const notEmpty = (v: string) => hasValue(v) && !no(v);

/** 国家奖学金 · 条件库（14 满足 / 2 待确认 / 1 未满足 的种子口径） */
export const SCHOLAR_CONDITIONS: ConditionRule[] = [
  {
    id: 's-enrolled',
    group: 'g-basic',
    item: '学籍在读',
    requirement: '全日制在读本科生',
    sourceQuote: '第二条：国家奖学金用于奖励高校全日制本专科（含高职、第二学士学位）在校生中特别优秀的学生。',
    sourceFile: '《XX大学国家奖学金评定办法》2026版 · 第二条',
    dependsOn: ['basic.enrolled'],
    judge: (v) => /在读|在校/.test(v),
  },
  {
    id: 's-registered',
    group: 'g-basic',
    item: '按时注册',
    requirement: '每学年按时完成注册',
    sourceQuote: '第三条：申请者须为已按时完成当学年注册的在校学生。',
    sourceFile: '《XX大学国家奖学金评定办法》2026版 · 第三条',
    dependsOn: ['basic.enrolled'],
    judge: () => true,
  },
  {
    id: 's-within-years',
    group: 'g-basic',
    item: '学制年限内',
    requirement: '处于正常学制年限内',
    sourceQuote: '第三条：申请者须处于正常学制年限内，不含延长学习年限学生。',
    sourceFile: '《XX大学国家奖学金评定办法》2026版 · 第三条',
    dependsOn: ['basic.grade'],
    judge: () => true,
  },
  {
    id: 's-no-discipline',
    group: 'g-basic',
    item: '无处分记录',
    requirement: '在校期间无纪律处分',
    sourceQuote: '第三条：申请者在校期间无违反校规校纪记录。',
    sourceFile: '《XX大学国家奖学金评定办法》2026版 · 第三条',
    dependsOn: ['other.discipline'],
    judge: (v) => no(v),
  },
  {
    id: 's-gpa',
    group: 'g-academic',
    item: 'GPA 成绩',
    requirement: '平均学分绩点不低于 3.5',
    sourceQuote: '第四条：申请者上一学年平均学分绩点不低于 3.5。',
    sourceFile: '《XX大学国家奖学金评定办法》2026版 · 第四条',
    dependsOn: ['academic.gpa'],
    judge: (v) => gteNum(v, 3.5),
  },
  {
    id: 's-rank',
    group: 'g-academic',
    item: '专业排名',
    requirement: '专业综合排名前 30%',
    sourceQuote: '第四条：申请者专业综合测评排名原则上进入前 30%。',
    sourceFile: '《XX大学国家奖学金评定办法》2026版 · 第四条',
    dependsOn: ['academic.rank'],
    judge: (v) => ratioOk(v, 0.3),
  },
  {
    id: 's-no-fail',
    group: 'g-academic',
    item: '无挂科记录',
    requirement: '上一学年无不及格课程',
    sourceQuote: '第四条：申请者上一学年无不及格课程记录。',
    sourceFile: '《XX大学国家奖学金评定办法》2026版 · 第四条',
    dependsOn: ['academic.fail'],
    judge: (v) => no(v),
  },
  {
    id: 's-course-min',
    group: 'g-academic',
    item: '课程成绩',
    requirement: '全部课程成绩不低于 60 分',
    sourceQuote: '第四条：申请者课程成绩均不低于 60 分。',
    sourceFile: '《XX大学国家奖学金评定办法》2026版 · 第四条',
    dependsOn: ['academic.courseMin'],
    judge: (v) => no(v) || /不低于|≥|60/.test(v),
  },
  {
    id: 's-cet4',
    group: 'g-english',
    item: 'CET-4 成绩',
    requirement: 'CET-4 不低于 425 分',
    sourceQuote: '第五条：申请者须通过全国大学英语四级考试（425 分及以上）。',
    sourceFile: '《XX大学国家奖学金评定办法》2026版 · 第五条',
    dependsOn: ['english.cet4'],
    judge: (v) => gteNum(v, 425),
  },
  {
    id: 's-cet6',
    group: 'g-english',
    item: 'CET-6 成绩',
    requirement: 'CET-6 不低于 450 分',
    sourceQuote: '第五条：同等条件下，通过六级考试（450 分及以上）者优先。',
    sourceFile: '《XX大学国家奖学金评定办法》2026版 · 第五条',
    dependsOn: ['english.cet6'],
    judge: (v) => gteNum(v, 450),
  },
  {
    id: 's-comprehensive',
    group: 'g-performance',
    item: '综合测评',
    requirement: '综合测评成绩不低于 85 分',
    sourceQuote: '第六条：申请者综合测评成绩不低于 85 分。',
    sourceFile: '《XX大学国家奖学金评定办法》2026版 · 第六条',
    dependsOn: ['performance.comprehensive'],
    judge: (v) => gteNum(v, 85),
  },
  {
    id: 's-volunteer',
    group: 'g-performance',
    item: '志愿服务',
    requirement: '年度志愿服务不少于 20 小时',
    sourceQuote: '第六条：申请者当学年志愿服务时长不少于 20 小时。',
    sourceFile: '《XX大学国家奖学金评定办法》2026版 · 第六条',
    dependsOn: ['performance.volunteer'],
    judge: (v) => {
      const m = v.match(/(\d+)\s*(小时|h)/i);
      return !!m && Number(m[1]) >= 20;
    },
  },
  {
    id: 's-no-violation',
    group: 'g-performance',
    item: '无违纪记录',
    requirement: '当学年无违纪记录',
    sourceQuote: '第六条：申请者当学年无违纪违规记录。',
    sourceFile: '《XX大学国家奖学金评定办法》2026版 · 第六条',
    dependsOn: ['other.discipline'],
    judge: (v) => no(v),
  },
  {
    id: 's-research',
    group: 'g-apply',
    item: '科研成果',
    requirement: '至少 1 项公开发表成果或科研项目',
    sourceQuote: '第七条：申请者须具有至少 1 项公开发表的学术成果或主持/参与的科研项目。',
    sourceFile: '《XX大学国家奖学金评定办法》2026版 · 第七条',
    dependsOn: ['research.research'],
    judge: (v) => notEmpty(v),
  },
  {
    id: 's-recommendation',
    group: 'g-apply',
    item: '专家推荐信',
    requirement: '至少 1 封专家推荐信',
    sourceQuote: '第七条：申请者须提交至少 1 封任课教师或导师推荐信。',
    sourceFile: '《XX大学国家奖学金评定办法》2026版 · 第七条',
    dependsOn: ['other.recommendation'],
    judge: (v) => notEmpty(v),
  },
  {
    id: 's-activity',
    group: 'g-apply',
    item: '学术活动参与',
    requirement: '参加校级及以上学术活动',
    sourceQuote: '第七条：申请者须参加校级及以上学术活动或学科竞赛。',
    sourceFile: '《XX大学国家奖学金评定办法》2026版 · 第七条',
    dependsOn: ['performance.activity'],
    judge: (v) => !/^无|未提供/.test(v) && /参加|有/.test(v),
  },
  {
    id: 's-materials',
    group: 'g-materials',
    item: '申请材料',
    requirement: '按要求提交全部申请材料',
    sourceQuote: '第八条：申请者须按要求完整提交申请材料，逾期不予受理。',
    sourceFile: '《XX大学国家奖学金评定办法》2026版 · 第八条',
    dependsOn: ['other.materials'],
    judge: (v) => notEmpty(v),
  },
];

/** 研究生推免 · 条件库（推免 2026 版：GPA 门槛 3.7） */
export const TUIMIAN_CONDITIONS: ConditionRule[] = [
  {
    id: 't-enrolled',
    group: 'g-basic',
    item: '学籍在读',
    requirement: '应届本科毕业生',
    sourceQuote: '第二条：推荐对象为当年应届本科毕业生。',
    sourceFile: '《XX大学推荐免试攻读研究生工作办法》2026版 · 第二条',
    dependsOn: ['basic.enrolled', 'basic.grade'],
    judge: (v) => /在读|在校/.test(v),
  },
  {
    id: 't-no-discipline',
    group: 'g-basic',
    item: '无处分记录',
    requirement: '在校期间无纪律处分',
    sourceQuote: '第三条：申请者在校期间无违反校规校纪记录。',
    sourceFile: '《XX大学推荐免试攻读研究生工作办法》2026版 · 第三条',
    dependsOn: ['other.discipline'],
    judge: (v) => no(v),
  },
  {
    id: 't-rank',
    group: 'g-academic',
    item: '专业排名',
    requirement: '专业综合排名前 20%',
    sourceQuote: '第四条：申请者专业综合排名原则上进入前 20%。',
    sourceFile: '《XX大学推荐免试攻读研究生工作办法》2026版 · 第四条',
    dependsOn: ['academic.rank'],
    judge: (v) => ratioOk(v, 0.2),
  },
  {
    id: 't-gpa',
    group: 'g-academic',
    item: 'GPA 成绩',
    requirement: '平均学分绩点不低于 3.7（2026 版调整）',
    sourceQuote: '第四条：申请者平均学分绩点不低于 3.7（2025 版为 3.8，2026 版起放宽）。',
    sourceFile: '《XX大学推荐免试攻读研究生工作办法》2026版 · 第四条',
    dependsOn: ['academic.gpa'],
    judge: (v) => gteNum(v, 3.7),
  },
  {
    id: 't-no-fail',
    group: 'g-academic',
    item: '无挂科记录',
    requirement: '在校期间无不及格课程',
    sourceQuote: '第四条：申请者在校期间无不及格课程记录。',
    sourceFile: '《XX大学推荐免试攻读研究生工作办法》2026版 · 第四条',
    dependsOn: ['academic.fail'],
    judge: (v) => no(v),
  },
  {
    id: 't-cet6',
    group: 'g-english',
    item: 'CET-6 成绩',
    requirement: 'CET-6 不低于 425 分',
    sourceQuote: '第五条：申请者须通过全国大学英语六级考试（425 分及以上）。',
    sourceFile: '《XX大学推荐免试攻读研究生工作办法》2026版 · 第五条',
    dependsOn: ['english.cet6'],
    judge: (v) => gteNum(v, 425),
  },
  {
    id: 't-comprehensive',
    group: 'g-performance',
    item: '综合测评',
    requirement: '综合测评成绩不低于 85 分',
    sourceQuote: '第六条：申请者综合测评成绩不低于 85 分。',
    sourceFile: '《XX大学推荐免试攻读研究生工作办法》2026版 · 第六条',
    dependsOn: ['performance.comprehensive'],
    judge: (v) => gteNum(v, 85),
  },
  {
    id: 't-research',
    group: 'g-apply',
    item: '科研经历',
    requirement: '具有科研经历或学术成果',
    sourceQuote: '第七条：申请者须具有科研训练经历或公开发表学术成果。',
    sourceFile: '《XX大学推荐免试攻读研究生工作办法》2026版 · 第七条',
    dependsOn: ['research.research'],
    judge: (v) => notEmpty(v),
  },
];

// ---------- 匹配引擎 ----------
export interface MatchOutcome {
  groups: ConditionGroup[];
  summary: MatchSummary;
}

/** 学业奖学金 · 条件库（轻量，适合学业奖学金 / 励志类评定） */
export const STUDY_CONDITIONS: ConditionRule[] = [
  {
    id: 'y-enrolled',
    group: 'g-basic',
    item: '学籍在读',
    requirement: '全日制在读学生',
    sourceQuote: '第二条：学业奖学金用于奖励在校期间学业表现良好的全日制学生。',
    sourceFile: '《XX大学学业奖学金评定办法》2026版 · 第二条',
    dependsOn: ['basic.enrolled'],
    judge: (v) => /在读|在校/.test(v),
  },
  {
    id: 'y-no-discipline',
    group: 'g-basic',
    item: '无处分记录',
    requirement: '在校期间无纪律处分',
    sourceQuote: '第三条：申请者在校期间无违反校规校纪记录。',
    sourceFile: '《XX大学学业奖学金评定办法》2026版 · 第三条',
    dependsOn: ['other.discipline'],
    judge: (v) => no(v),
  },
  {
    id: 'y-gpa',
    group: 'g-academic',
    item: 'GPA 成绩',
    requirement: '平均学分绩点不低于 2.8',
    sourceQuote: '第四条：申请者上一学年平均学分绩点不低于 2.8。',
    sourceFile: '《XX大学学业奖学金评定办法》2026版 · 第四条',
    dependsOn: ['academic.gpa'],
    judge: (v) => gteNum(v, 2.8),
  },
  {
    id: 'y-no-fail',
    group: 'g-academic',
    item: '无挂科记录',
    requirement: '上一学年无不及格课程',
    sourceQuote: '第四条：申请者上一学年无不及格课程。',
    sourceFile: '《XX大学学业奖学金评定办法》2026版 · 第四条',
    dependsOn: ['academic.fail'],
    judge: (v) => no(v),
  },
  {
    id: 'y-comprehensive',
    group: 'g-performance',
    item: '综合测评',
    requirement: '综合测评成绩不低于 75 分',
    sourceQuote: '第五条：申请者综合测评成绩须达到良好以上。',
    sourceFile: '《XX大学学业奖学金评定办法》2026版 · 第五条',
    dependsOn: ['performance.comprehensive'],
    judge: (v) => gteNum(v, 75),
  },
];

export const GROUPS: { id: string; label: string }[] = [
  { id: 'g-basic', label: '基础资格' },
  { id: 'g-academic', label: '学业成绩' },
  { id: 'g-english', label: '英语成绩' },
  { id: 'g-performance', label: '综合表现' },
  { id: 'g-apply', label: '申请资格' },
  { id: 'g-materials', label: '申请材料' },
];

export function matchConditions(profile: UserProfile, conditions: ConditionRule[]): MatchOutcome {
  const rows: MatchResult[] = conditions.map((c) => {
    const first = c.dependsOn[0];
    const fv = first ? (profile.fields[first]?.value ?? UNPROVIDED) : UNPROVIDED;
    let state: ConditionState;
    if (!hasValue(fv)) {
      state = 'missing';
    } else {
      try {
        state = c.judge(fv) ? 'met' : 'not_met';
      } catch {
        state = 'missing';
      }
    }
    return {
      conditionId: c.id,
      item: c.item,
      state,
      userValue: fv,
      requirement: c.requirement,
      sourceQuote: c.sourceQuote,
      sourceFile: c.sourceFile,
    };
  });

  const groups: ConditionGroup[] = GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    rows: rows.filter((r) => conditions.find((c) => c.id === r.conditionId)?.group === g.id),
  })).filter((g) => g.rows.length > 0);

  const summary: MatchSummary = {
    met: rows.filter((r) => r.state === 'met').length,
    missing: rows.filter((r) => r.state === 'missing').length,
    notMet: rows.filter((r) => r.state === 'not_met').length,
  };
  return { groups, summary };
}

// ---------- 目标意图识别 ----------
export interface GoalDef {
  goalKey: string;
  title: string;
  policyVersionId: string;
  conditions: ConditionRule[];
  /** 从用户话术中识别该目标的规则 */
  detect: RegExp;
  /** 模糊表达（需要确认） */
  vague?: RegExp;
}

export const GOALS: GoalDef[] = [
  {
    goalKey: 'national_scholarship',
    title: '国家奖学金资格分析',
    policyVersionId: 'pv-scholar-2026',
    conditions: SCHOLAR_CONDITIONS,
    detect: /国家?奖学金|国奖/,
  },
  {
    goalKey: 'study_scholarship',
    title: '学业奖学金资格分析',
    policyVersionId: 'pv-study-2026',
    conditions: STUDY_CONDITIONS,
    detect: /学业奖学金|学校奖学金|励志奖学金/,
  },
  {
    goalKey: 'tuimian',
    title: '研究生推免资格分析',
    policyVersionId: 'pv-tuimian-2026',
    conditions: TUIMIAN_CONDITIONS,
    detect: /推免|保研|研究生/,
    vague: /研究生|那个研究生|研究生呢/,
  },
  {
    goalKey: 'sanhao',
    title: '三好学生资格分析',
    policyVersionId: 'pv-scholar-2026',
    conditions: SCHOLAR_CONDITIONS,
    detect: /三好(学生)?/,
  },
];

export interface GoalPick {
  goalKey: string;
  title: string;
  ambiguous: boolean;
}

/** goalKey → 政策版本 id 前缀（报告详情 / 重新分析时定位最新政策用） */
export const goalPolicyPrefix = (goalKey: string): string => {
  if (goalKey === 'tuimian') return 'pv-tuimian';
  if (goalKey === 'study_scholarship') return 'pv-study';
  return 'pv-scholar';
};

export function detectGoal(text: string): GoalPick | null {
  const t = text.replace(/\s/g, '');
  for (const g of GOALS) {
    if (g.detect.test(t)) {
      return {
        goalKey: g.goalKey,
        title: g.title,
        ambiguous: !!g.vague && g.vague.test(t) && /呢|吗|怎么样|看看|那/.test(t),
      };
    }
  }
  return null;
}

// ---------- 信息抽取器（mock：从自然语言提取字段值） ----------
export interface FieldPick {
  fieldKey: string;
  value: string;
}

const PICK_PATTERNS: { fieldKey: string; re: RegExp; fmt: (m: RegExpMatchArray) => string }[] = [
  {
    fieldKey: 'english.cet6',
    re: /(?:六级|6级|cet-?6)\s*(?:成绩)?\D{0,6}(\d{3,4})/i,
    fmt: (m) => `${m[1]}`,
  },
  {
    fieldKey: 'english.cet4',
    re: /(?:四级|4级|cet-?4)\s*(?:成绩)?\D{0,6}(\d{3,4})/i,
    fmt: (m) => `${m[1]}`,
  },
  {
    fieldKey: 'academic.gpa',
    re: /(?:绩点|gpa)\D{0,4}([0-9](?:\.\d{1,2})?)/i,
    fmt: (m) => `${m[1]}`,
  },
  {
    fieldKey: 'academic.rank',
    re: /(?:排名|名次)\D{0,4}(\d{1,3})\s*\/\s*(\d{1,3})/,
    fmt: (m) => `${m[1]}/${m[2]}`,
  },
  {
    fieldKey: 'performance.comprehensive',
    re: /(?:综合测评|综测|综合成绩)\D{0,6}(\d{1,3})/,
    fmt: (m) => `${m[1]}`,
  },
  {
    fieldKey: 'performance.volunteer',
    re: /(?:志愿|志愿服务)\D{0,6}(\d{1,3})\s*(?:小时|h)/i,
    fmt: (m) => `${m[1]}小时`,
  },
  {
    fieldKey: 'research.research',
    re: /(?:科研|论文|成果|项目|专利|大创)/,
    fmt: () => '有科研经历',
  },
  {
    fieldKey: 'awards.awards',
    re: /(?:获奖|奖项|荣誉|奖学金.*(?:获得|拿到)|获得.*(?:奖|荣誉))/,
    fmt: () => '有获奖经历',
  },
  {
    fieldKey: 'other.discipline',
    re: /(?:处分|违纪)/,
    fmt: (m) => (/^有|受|被/.test(m[0]) ? '有处分记录' : '无处分记录'),
  },
  {
    fieldKey: 'basic.grade',
    re: /(大一|大二|大三|大四|研一|研二|研三)/,
    fmt: (m) => `${m[1]}`,
  },
  {
    fieldKey: 'basic.major',
    re: /(?:专业|读的|学的)是?([\u4e00-\u9fa5]{2,10}?(?:工程|科学|技术|管理|经济|文学|理学|医学|法学|教育|艺术|设计|数学|物理|化学|生物|计算机|软件))/,
    fmt: (m) => `${m[1]}`,
  },
];

export function extractFields(text: string): FieldPick[] {
  const picks: FieldPick[] = [];
  for (const p of PICK_PATTERNS) {
    const m = text.match(p.re);
    if (m) {
      const value = p.fmt(m);
      const existing = picks.find((x) => x.fieldKey === p.fieldKey);
      if (existing) existing.value = value;
      else picks.push({ fieldKey: p.fieldKey, value });
    }
  }
  return picks;
}

// ---------- 种子数据 ----------
export function createSeedProfile(): UserProfile {
  const f = (key: string, value: string, updatedAt: string): ProfileField => ({
    key,
    label: fieldLabel(key),
    category: fieldDefMap.get(key)?.category ?? 'other',
    value,
    updatedAt,
  });
  return {
    updatedAt: '2026-09-12',
    fields: {
      'basic.enrolled': f('basic.enrolled', '全日制在读本科生', '2026-09-01'),
      'basic.grade': f('basic.grade', '大三', '2026-09-01'),
      'basic.major': f('basic.major', '软件工程', '2026-09-01'),
      'academic.gpa': f('academic.gpa', '3.72', '2026-09-01'),
      'academic.rank': f('academic.rank', '12/120', '2026-09-08'),
      'academic.fail': f('academic.fail', '无', '2026-09-01'),
      'academic.courseMin': f('academic.courseMin', '无不及格课程', '2026-09-01'),
      'english.cet4': f('english.cet4', '542', '2026-09-08'),
      'english.cet6': f('english.cet6', '未提供', '2026-09-01'),
      'performance.comprehensive': f('performance.comprehensive', '未提供', '2026-09-01'),
      'performance.volunteer': f('performance.volunteer', '32小时', '2026-09-12'),
      'performance.activity': f('performance.activity', '参加校级学术讲座', '2026-09-12'),
      'awards.awards': f('awards.awards', '校优秀学生干部', '2026-09-12'),
      'research.research': f('research.research', '暂无相关成果', '2026-09-01'),
      'other.discipline': f('other.discipline', '无', '2026-09-01'),
      'other.recommendation': f('other.recommendation', '有（1封）', '2026-09-12'),
      'other.materials': f('other.materials', '齐全', '2026-09-12'),
    },
  };
}

export function createPolicyVersions(): PolicyVersion[] {
  return [
    {
      id: 'pv-scholar-2026',
      title: '《XX大学国家奖学金评定办法》',
      version: '2026版',
      publishedAt: '2026-08-20',
      latest: true,
    },
    {
      id: 'pv-study-2026',
      title: '《XX大学学业奖学金评定办法》',
      version: '2026版',
      publishedAt: '2026-08-22',
      latest: true,
    },
    {
      id: 'pv-tuimian-2026',
      title: '《XX大学推荐免试攻读研究生工作办法》',
      version: '2026版',
      publishedAt: '2026-09-05',
      latest: true,
    },
    {
      id: 'pv-tuimian-2025',
      title: '《XX大学推荐免试攻读研究生工作办法》',
      version: '2025版',
      publishedAt: '2025-06-28',
      latest: false,
    },
  ];
}

/** 快照字段选择器 */
function snapshotEntries(profile: UserProfile, keys: string[]): { label: string; value: string }[] {
  return keys
    .map((k) => profile.fields[k])
    .filter((f): f is ProfileField => !!f)
    .map((f) => ({ label: f.label, value: f.value }));
}

/** 国家奖学金 V3 的变化明细（种子数据用） */
function scholarChanges(): ReportChange[] {
  return [
    { label: '新增信息', text: '志愿服务 32小时；专家推荐信；学术活动参与' },
    { label: '结果变化', text: '12 项满足 → 14 项满足 · 4 项待确认 → 2 项待确认' },
  ];
}

export function createSeedState(): WorkbenchState {
  const profile = createSeedProfile();
  const policyVersions = createPolicyVersions();

  const scholar = matchConditions(profile, SCHOLAR_CONDITIONS);
  const tuimian = matchConditions(profile, TUIMIAN_CONDITIONS);
  const scholarMcp = engineGroupsToMcp(scholar.groups);
  const tuimianMcp = engineGroupsToMcp(tuimian.groups);

  const tasks: AnalysisTask[] = [
    {
      id: 'task-scholar',
      goalKey: 'national_scholarship',
      title: '国家奖学金资格分析',
      policyVersionId: 'pv-scholar-2026',
      createdAt: '2026-09-01',
      updatedAt: '2026-09-12',
      current: scholarMcp,
    },
    {
      id: 'task-tuimian',
      goalKey: 'tuimian',
      title: '研究生推免资格分析',
      policyVersionId: 'pv-tuimian-2026',
      createdAt: '2026-09-02',
      updatedAt: '2026-09-02',
      current: tuimianMcp,
    },
  ];

  const pvScholar = policyVersions[0];
  const pvTuimian25 = policyVersions[2];

  const reports: ReportSnapshot[] = [
    {
      id: 'r-scholar-v1',
      version: 1,
      createdAt: '2026-09-01',
      analysisTaskId: 'task-scholar',
      profileSnapshot: snapshotEntries(profile, [
        'basic.enrolled',
        'basic.grade',
        'academic.gpa',
        'academic.fail',
        'english.cet4',
        'other.discipline',
      ]),
      policyVersion: pvScholar,
      matchResults: scholarMcp,
      summary: { met: 12, missing: 4, notMet: 1 },
      changes: [
        { label: '创建分析', text: '创建分析任务「国家奖学金资格分析」' },
        { label: '首次匹配', text: '完成首次政策匹配：12 项满足 · 4 项待确认 · 1 项未满足' },
      ],
    },
    {
      id: 'r-scholar-v2',
      version: 2,
      createdAt: '2026-09-08',
      analysisTaskId: 'task-scholar',
      profileSnapshot: snapshotEntries(profile, [
        'basic.enrolled',
        'basic.grade',
        'academic.gpa',
        'academic.rank',
        'academic.fail',
        'english.cet4',
        'other.discipline',
      ]),
      policyVersion: pvScholar,
      matchResults: scholarMcp,
      summary: { met: 13, missing: 3, notMet: 1 },
      changes: [
        { label: '新增信息', text: '专业排名 12/120' },
        { label: '结果变化', text: '12 项满足 → 13 项满足 · 4 项待确认 → 3 项待确认' },
      ],
    },
    {
      id: 'r-scholar-v3',
      version: 3,
      createdAt: '2026-09-12',
      analysisTaskId: 'task-scholar',
      profileSnapshot: snapshotEntries(profile, [
        'basic.enrolled',
        'basic.grade',
        'academic.gpa',
        'academic.rank',
        'academic.fail',
        'english.cet4',
        'performance.volunteer',
        'performance.activity',
        'awards.awards',
        'other.discipline',
        'other.recommendation',
        'other.materials',
      ]),
      policyVersion: pvScholar,
      matchResults: scholarMcp,
      summary: scholar.summary,
      changes: scholarChanges(),
    },
    {
      id: 'r-tuimian-v1',
      version: 1,
      createdAt: '2026-09-02',
      analysisTaskId: 'task-tuimian',
      profileSnapshot: snapshotEntries(profile, [
        'basic.enrolled',
        'basic.grade',
        'academic.gpa',
        'academic.rank',
        'academic.fail',
        'english.cet4',
        'other.discipline',
      ]),
      // 锁定旧版政策：2025 版（GPA 门槛 3.8）
      policyVersion: pvTuimian25,
      matchResults: engineGroupsToMcp(tuimian.groups).map((g) => ({
        ...g,
        rows: g.rows.map((r) => (r.id === 't-gpa' ? { ...r, match: 'not_met' as const } : r)),
      })),
      summary: { met: 4, missing: 1, notMet: 2 },
      changes: [
        { label: '创建分析', text: '创建分析任务「研究生推免资格分析」' },
        { label: '政策锁定', text: '基于《推荐免试工作办法》2025版完成匹配' },
      ],
    },
  ];

  const conversations: Conversation[] = [
    {
      id: 'conv-scholar',
      taskId: 'task-scholar',
      messages: [
        {
          id: 'm-s1',
          kind: 'system_goal',
          text: '已恢复分析任务「国家奖学金资格分析」。当前缺少 2 项信息：CET-6 成绩、综合测评。',
          createdAt: '2026-09-12',
        },
      ],
    },
    {
      id: 'conv-tuimian',
      taskId: 'task-tuimian',
      messages: [
        {
          id: 'm-t1',
          kind: 'system_goal',
          text: '已创建分析任务「研究生推免资格分析」，当前政策为《推荐免试工作办法》2026版。',
          createdAt: '2026-09-02',
        },
      ],
    },
  ];

  return { profile, policyVersions, tasks, conversations, reports };
}

/** 报告里可读的「当前 vs 最新政策」判断 */
export const findPolicy = (state: WorkbenchState, id: string): PolicyVersion | undefined =>
  state.policyVersions.find((p) => p.id === id);
