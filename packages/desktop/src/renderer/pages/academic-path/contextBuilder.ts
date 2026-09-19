/**
 * 学业路径上下文构建器：把培养方案+课程数据+学生状态序列化为 AI 可读的文本。
 * 每次发送消息时拼接到 input 前面，让 AI 基于完整学业路径回答。
 */
import type { Course, ProgramPlan, StudentProgress } from './types';

function statusLabel(status: string | undefined): string {
  if (status === 'passed') return '已通过';
  if (status === 'failed') return '未通过';
  return '未修读';
}

/**
 * 构建学业路径上下文文本。
 * @param plan 培养方案（课程列表+先修关系）
 * @param progress 学生修读状态
 * @param selectedCourse 当前选中的课程（可选）
 * @returns 拼接好的上下文字符串
 */
export function buildAcademicContext(
  plan: ProgramPlan,
  progress: StudentProgress,
  selectedCourse: Course | null,
): string {
  const totalCourses = plan.courses.length;
  const totalCredits = plan.courses.reduce((sum, c) => sum + c.credits, 0);

  let passed = 0;
  let failed = 0;
  let notTaken = 0;
  plan.courses.forEach((c) => {
    const s = progress.courseStatuses[c.id];
    if (s === 'passed') passed++;
    else if (s === 'failed') failed++;
    else notTaken++;
  });

  const earnedCredits = plan.courses
    .filter((c) => progress.courseStatuses[c.id] === 'passed')
    .reduce((sum, c) => sum + c.credits, 0);

  let ctx = '【学业路径助手·上下文】\n';
  ctx += `培养方案：${plan.major} ${plan.grade}级，共${totalCourses}门课，${totalCredits}学分。\n`;
  ctx += `学生进度：已通过${passed}门，未通过${failed}门，未修读${notTaken}门，已获学分${earnedCredits}/${totalCredits}。\n`;

  // 课程列表
  ctx += '\n课程列表（课程名 学分 类别 状态）：\n';
  plan.courses.forEach((c) => {
    const s = progress.courseStatuses[c.id];
    ctx += `  ${c.name} ${c.credits}学分 ${c.categoryLabel} ${statusLabel(s)}\n`;
  });

  // 先修关系
  const withPrereqs = plan.courses.filter((c) => c.prerequisites && c.prerequisites.length > 0);
  if (withPrereqs.length > 0) {
    ctx += '\n先修关系：\n';
    withPrereqs.forEach((c) => {
      const names = c.prerequisites
        .map((pid) => plan.courses.find((pc) => pc.id === pid)?.name)
        .filter(Boolean)
        .join('、');
      if (names) {
        ctx += `  ${c.name} → 先修：${names}\n`;
      }
    });
  }

  // 当前选中课程
  if (selectedCourse) {
    const s = progress.courseStatuses[selectedCourse.id];
    const prereqNames = selectedCourse.prerequisites
      .map((pid) => plan.courses.find((pc) => pc.id === pid)?.name)
      .filter(Boolean)
      .join('、');
    // 后续课程
    const followups = plan.courses
      .filter((c) => c.prerequisites && c.prerequisites.includes(selectedCourse.id))
      .map((c) => c.name)
      .join('、');

    ctx += `\n当前查看课程：${selectedCourse.name}（${selectedCourse.credits}学分，${selectedCourse.categoryLabel}），状态：${statusLabel(s)}`;
    if (prereqNames) ctx += `，先修课程：${prereqNames}`;
    if (followups) ctx += `，后续课程：${followups}`;
  }

  ctx += '\n\n请基于以上学业路径数据回答用户问题。\n用户问题：';
  return ctx;
}
