// ========== 申请清单页：对话预填解析器 ==========
// 从用户问题原文（query_policy 工具 input 里的 question/query/prompt）提取
// 结构化信息，映射到清单条件。仅做确定性规则提取，不依赖 LLM；
// 提取不到就保持空白，绝不臆造数值。
import type { ChecklistHints } from './checklistPanelStore';

const num = (s: string): number | null => {
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** 百分数/分数 → 数值（前10% → 10；前1/3 → 33.33） */
const percentValue = (s: string): number | null => {
  if (/%$/.test(s)) {
    return num(s.replace(/%/g, '').trim());
  }
  const frac = s.match(/^1\s*\/\s*(\d+)$/);
  if (frac) return Math.round((100 / Number(frac[1])) * 100) / 100;
  return num(s);
};

/**
 * 从 query_policy 工具参数里的 user_info（LLM 按 schema 提取的结构化个人信息）
 * 提取预填值。比文本正则更可靠，优先使用：
 *  - user_info.gpa → 平均学分绩点
 *  - user_info.gpa_rank_percent → 学业成绩排名（12.5 = 前12.5%）
 *  - user_info.extra 中的志愿/义工时长 → 义工服务时长
 */
export function extractUserInfoHints(userInfo: unknown): ChecklistHints {
  if (!userInfo || typeof userInfo !== 'object' || Array.isArray(userInfo)) return {};
  const info = userInfo as Record<string, unknown>;
  const hints: ChecklistHints = {};

  const gpa = info.gpa;
  if (typeof gpa === 'number' && Number.isFinite(gpa) && gpa > 0 && gpa <= 5) {
    hints['平均学分绩点'] = gpa;
  }

  const rank = info.gpa_rank_percent;
  if (typeof rank === 'number' && Number.isFinite(rank) && rank > 0 && rank <= 100) {
    hints['学业成绩排名'] = rank;
  }

  const extra = info.extra;
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    for (const [key, value] of Object.entries(extra as Record<string, unknown>)) {
      if (/志愿|义工|volunteer|hours|时长/i.test(key) && typeof value === 'number' && Number.isFinite(value)) {
        hints['义工服务时长'] = value;
        break;
      }
    }
  }

  return hints;
}

/**
 * 提取用户问题中的关键条件，返回按清单条件 item 名索引的预填值。
 * 支持：
 *  - 绩点：绩点/GPA/平均学分绩点 + 数值（3.8）
 *  - 排名：排名…前10% / 前1/3 / 前15%（学业成绩排名优先）
 *  - 综测排名：综合素质…排名…前X%
 *  - 义工时长：义工…N小时
 *  - 年级：大二/大二及以上/二年级以上
 */
export function parseUserHints(question: string): ChecklistHints {
  const text = (question ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return {};
  const hints: ChecklistHints = {};

  // 绩点：绩点/GPA 后跟数值
  const gpa = text.match(/(?:绩点|GPA|平均学分绩点)\s*[:：为是]?\s*(\d+(?:\.\d+)?)/i);
  if (gpa) {
    const v = num(gpa[1]);
    if (v !== null && v > 0 && v <= 5) hints['平均学分绩点'] = v;
  }

  // 排名：先匹配"综合素质(测评)?…排名…前X"，否则匹配"排名/排名要求…前X"
  const zhText = text.toLowerCase();
  const isZongce = /综合素质|综测/.test(zhText) && /排名|前/.test(zhText);
  const rank = text.match(/排名[^，。；,.;]{0,15}前\s*(\d+(?:\.\d+)?\s*%|1\s*\/\s*\d+)/);
  if (rank) {
    const v = percentValue(rank[1].trim());
    if (v !== null && v > 0 && v <= 100) {
      hints[isZongce ? '综合素质测评成绩排名' : '学业成绩排名'] = v;
    }
  }

  // 义工时长：义工…N小时
  const volunteer = text.match(/义工[^0-9]{0,10}(\d+(?:\.\d+)?)\s*小时/);
  if (volunteer) {
    const v = num(volunteer[1]);
    if (v !== null && v >= 0 && v <= 10000) hints['义工服务时长'] = v;
  }

  // 年级：大二及以上 / 二年级以上 / 大二
  if (/大二|二年级/.test(zhText)) {
    hints['年级要求'] = true;
  }

  return hints;
}
