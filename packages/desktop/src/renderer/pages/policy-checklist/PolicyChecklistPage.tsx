// ========== 申请清单页：主页面 ==========
// 结构（自上而下）：文档头 → 一票否决确认条 → 基础门槛 → 加分项 → 其他须知
// 判定顺序（与后端一致）：VETO 短路 → BASE 缺口 → BONUS 提供情况
// 提交后视图：未确认项置顶（待确认区）→ 已确认项集中（已确认区），全部由字段判定驱动
// 数据源：完全由对话实时 query_policy 返回（store.rawResults）驱动——
//   提问 → AI 调用 query_policy → 后端返回该分类下全部政策的匹配结果
//   → 按工作台所选文件（标题）过滤 → 渲染所选文件的真实判定清单；未选文件渲染全部。
// 尚未提问/无返回时显示引导空态（页面不出现清单）。
// 前端只按字段渲染，不做中文语义判断；不提供任何手动选择文件的控件。
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Empty, Message, Tag, Typography } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { groupByBoard, evaluateChecklist, isBaseMet } from './adaptPolicyDoc';
import { adaptQueryPolicyResult, isBackendMet, type AdaptedChecklist } from './adaptQueryPolicyResult';
import BonusBoard from './BonusBoard';
import GateBoard from './GateBoard';
import OtherNotice from './OtherNotice';
import VetoStrip from './VetoStrip';
import type { AnswerValue, Answers, EvidenceFile, EvidenceMap, PolicyCondition, PolicyDoc } from './types';
import { usePolicyChecklistPanel } from './checklistPanelStore';

/** 单条条件是否已由用户填写（判定是否从"后端状态"切换到"前端输入驱动"） */
function isFilled(condition: PolicyCondition, value: Answers[string], evidence: EvidenceMap): boolean {
  if ((evidence[condition.id]?.length ?? 0) > 0) return true;
  switch (condition.input_kind) {
    case 'yes_no':
      return value === true || value === false;
    case 'upload':
      return false; // upload 以上面的 evidence 判定
    default:
      return value !== undefined && value !== null && value !== '';
  }
}

/** 单份清单（多文件模式下每份一个区块）：文档头 → 判定 → 板块 → 提交视图 */
const ChecklistSection: React.FC<{
  adapted: AdaptedChecklist;
  answers: Answers;
  evidence: EvidenceMap;
  submitted: boolean;
  onAnswer: (id: string, value: AnswerValue) => void;
  onEvidence: (id: string, files: EvidenceFile[]) => void;
}> = ({ adapted, answers, evidence, submitted, onAnswer, onEvidence }) => {
  const { t } = useTranslation();
  const docMeta = adapted.meta;
  const allConditions = adapted.conditions;
  const verdict = adapted.verdict;
  const groups = useMemo(() => groupByBoard(allConditions), [allConditions]);

  // 即时校验：基础门槛逐条达标状态（未填写 → 后端判定；已填写 → 前端按输入驱动）
  const metMap = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const condition of groups.base) {
      map[condition.id] = isFilled(condition, answers[condition.id], evidence)
        ? isBaseMet(condition, answers[condition.id], evidence)
        : isBackendMet(condition.backendMatch);
    }
    return map;
  }, [groups.base, answers, evidence]);

  // 提交后分组：待确认（未达标门槛 + 未提供加分项）置顶；已确认（达标门槛 + 已提供加分项）集中
  const submittedGroups = useMemo(() => {
    const pendingBase = groups.base.filter((c) => !metMap[c.id]);
    const confirmedBase = groups.base.filter((c) => metMap[c.id]);
    const pendingBonus = groups.bonus.filter((c) => !isFilled(c, answers[c.id], evidence));
    const confirmedBonus = groups.bonus.filter((c) => isFilled(c, answers[c.id], evidence));
    return { pendingBase, confirmedBase, pendingBonus, confirmedBonus };
  }, [groups.base, groups.bonus, metMap, answers, evidence]);

  const pendingCount = submittedGroups.pendingBase.length + submittedGroups.pendingBonus.length;
  const confirmedCount = submittedGroups.confirmedBase.length + submittedGroups.confirmedBonus.length;

  return (
    <section className='flex flex-col gap-20px'>
      {/* 文档头 */}
      <div className='flex flex-col gap-6px'>
        <Typography.Title heading={3} style={{ marginBottom: 4 }}>
          {docMeta.title}
        </Typography.Title>
        <Typography.Text type='secondary' style={{ fontSize: 13 }}>
          {docMeta.school} · {docMeta.department} · {t('policyChecklist.metaEffective', { date: docMeta.effective_date })}
        </Typography.Text>
        <Typography.Text type='secondary' style={{ fontSize: 12 }}>
          {t('policyChecklist.metaSource')}：{docMeta.source_file}
        </Typography.Text>
      </div>

      {/* 判定结果条 */}
      {verdict.status === 'disqualified' && (
        <Alert
          type='error'
          title={t('policyChecklist.verdict.disqualified')}
          content={
            <ul className='m-0 pl-16px'>
              {verdict.hitVetoes.map((c) => (
                <li key={c.id} style={{ fontSize: 13 }}>
                  {c.item}（{c.source_section}）
                </li>
              ))}
            </ul>
          }
        />
      )}
      {verdict.status === 'incomplete' && (
        <Alert
          type='warning'
          title={t('policyChecklist.verdict.incomplete')}
          content={t('policyChecklist.verdict.incompleteDesc', {
            met: verdict.metCount,
            total: verdict.baseTotal,
            gaps: verdict.gaps.length,
          })}
        />
      )}
      {verdict.status === 'qualified' && (
        <Alert
          type='success'
          title={t('policyChecklist.verdict.qualified')}
          content={t('policyChecklist.verdict.qualifiedDesc', { bonus: verdict.bonusProvided })}
        />
      )}

      {/* ① 一票否决（命中任一 → 短路收起下方） */}
      <VetoStrip conditions={groups.veto} answers={answers} onAnswer={onAnswer} />

      {/* ② 基础门槛 + ③ 加分项（veto 命中时收起） */}
      {verdict.status !== 'disqualified' && !submitted && (
        <>
          <GateBoard
            conditions={groups.base}
            answers={answers}
            evidence={evidence}
            onAnswer={onAnswer}
            onEvidence={onEvidence}
            metMap={metMap}
          />
          <BonusBoard
            conditions={groups.bonus}
            answers={answers}
            evidence={evidence}
            onAnswer={onAnswer}
            onEvidence={onEvidence}
          />
        </>
      )}

      {/* 提交后视图：未确认项置顶（待确认区）→ 已确认项集中（已确认区） */}
      {verdict.status !== 'disqualified' && submitted && (
        <>
          {pendingCount === 0 ? (
            <Alert type='success' title={t('policyChecklist.submittedAllDone')} />
          ) : (
            <section className='flex flex-col gap-12px'>
              <div className='flex items-center gap-8px'>
                <span
                  className='px-8px py-2px rd-6px'
                  style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-warning-6)', background: 'var(--color-warning-1)' }}
                >
                  ⚠ {t('policyChecklist.submittedPendingTitle', { count: pendingCount })}
                </span>
              </div>
              <GateBoard
                conditions={submittedGroups.pendingBase}
                answers={answers}
                evidence={evidence}
                onAnswer={onAnswer}
                onEvidence={onEvidence}
                metMap={metMap}
                submitted
              />
              <BonusBoard
                conditions={submittedGroups.pendingBonus}
                answers={answers}
                evidence={evidence}
                onAnswer={onAnswer}
                onEvidence={onEvidence}
                submitted
              />
            </section>
          )}

          {confirmedCount > 0 && (
            <section className='flex flex-col gap-12px'>
              <div className='flex items-center gap-8px'>
                <span
                  className='px-8px py-2px rd-6px'
                  style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-success-6)', background: 'var(--color-success-1)' }}
                >
                  ✓ {t('policyChecklist.submittedConfirmedTitle', { count: confirmedCount })}
                </span>
              </div>
              <GateBoard
                conditions={submittedGroups.confirmedBase}
                answers={answers}
                evidence={evidence}
                onAnswer={onAnswer}
                onEvidence={onEvidence}
                metMap={metMap}
                submitted
              />
              <BonusBoard
                conditions={submittedGroups.confirmedBonus}
                answers={answers}
                evidence={evidence}
                onAnswer={onAnswer}
                onEvidence={onEvidence}
                submitted
              />
            </section>
          )}
        </>
      )}
      <OtherNotice conditions={groups.other} />
    </section>
  );
};

const PolicyChecklistPage: React.FC = () => {
  const { t } = useTranslation();
  const { rawResults, hints, selectedDocs } = usePolicyChecklistPanel();

  // 实时数据源：完整 results 数组 → 每份政策适配一份清单
  const liveList = useMemo(
    () => (rawResults ? rawResults.map((r) => adaptQueryPolicyResult(r)) : []),
    [rawResults]
  );

  // 按工作台所选文件（标题）过滤；未选 → 全部；选了但返回里没有 → 全部（不空白）
  const sources = useMemo(() => {
    if (selectedDocs.length === 0) return liveList;
    const filtered = liveList.filter((a) => selectedDocs.includes(a.meta.title));
    return filtered.length > 0 ? filtered : liveList;
  }, [liveList, selectedDocs]);

  const allConditions = useMemo(() => sources.flatMap((s) => s.conditions), [sources]);

  const [answers, setAnswers] = useState<Answers>({});
  const [evidence, setEvidence] = useState<EvidenceMap>({});
  // 是否已提交自评：提交后切换为"待确认置顶 + 已确认集中"视图
  const [submitted, setSubmitted] = useState(false);

  // 新一轮实时返回（新的问答）到达时清空作答，避免跨问题残留
  const [renderedRaw, setRenderedRaw] = useState<typeof rawResults>(rawResults);
  if (rawResults !== renderedRaw) {
    setRenderedRaw(rawResults);
    setAnswers({});
    setEvidence({});
    setSubmitted(false);
  }

  // 对话预填：AI 触发清单时，把问题里提到的信息自动填入对应条件（幂等，不覆盖手填）
  useEffect(() => {
    if (sources.length === 0 || Object.keys(hints).length === 0) return;
    setAnswers((prev) => {
      const next = { ...prev };
      for (const [itemName, value] of Object.entries(hints)) {
        const condition = allConditions.find((c) => c.item === itemName && next[c.id] === undefined);
        if (condition) next[condition.id] = value;
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hints, sources]);

  const handleAnswer = (id: string, value: AnswerValue) => {
    setAnswers((prev) => ({ ...prev, [id]: value }));
  };
  const handleEvidence = (id: string, files: EvidenceFile[]) => {
    setEvidence((prev) => ({ ...prev, [id]: files }));
  };

  const reset = () => {
    setAnswers({});
    setEvidence({});
    setSubmitted(false);
  };

  const submit = () => {
    // 阶段 1：仅前端判定；真实提交 payload（answers + evidence）等后端通道确认后再接
    const confirmed = allConditions.filter((c) => isFilled(c, answers[c.id], evidence)).length;
    console.log('[PolicyChecklist] submit payload', {
      docs: sources.map((s) => s.meta.doc_id),
      answers: Object.entries(answers).map(([id, value]) => ({
        id,
        input_kind: allConditions.find((c) => c.id === id)?.input_kind,
        value,
      })),
      evidence,
    });
    setSubmitted(true);
    Message.success(
      t('policyChecklist.submittedSummary', {
        pending: allConditions.length - confirmed,
        confirmed,
      })
    );
  };

  // 尚未提问 / 尚无实时返回 → 引导空态（清单不出现）
  if (sources.length === 0) {
    return (
      <div className='mx-auto flex flex-col gap-16px pt-40px px-24px pb-48px' style={{ maxWidth: 860 }}>
        <div className='flex items-center gap-8px'>
          <Tag color='arcoblue'>{t('policyChecklist.pageTag')}</Tag>
          <Typography.Text type='secondary' style={{ fontSize: 12 }}>
            {t('policyChecklist.docPickerNoneHint')}
          </Typography.Text>
        </div>
        <div className='flex items-center justify-center' style={{ minHeight: 320 }}>
          <Empty description={t('policyChecklist.emptyBeforeAsk')} />
        </div>
      </div>
    );
  }

  return (
    <div
      className='mx-auto flex flex-col gap-24px pt-40px px-24px pb-48px'
      style={{ maxWidth: 860 }}
    >
      {/* 顶部：实时标记 + 过滤提示 */}
      <div className='flex items-center gap-8px flex-wrap'>
        <Tag color='green'>{t('policyChecklist.liveTag')}</Tag>
        <Tag color='arcoblue'>{t('policyChecklist.pageTag')}</Tag>
        {selectedDocs.length > 0 ? (
          <Tag>{t('policyChecklist.filterBySelected')}</Tag>
        ) : (
          <Tag>{t('policyChecklist.followQuestion')}</Tag>
        )}
      </div>

      {/* 清单区块（多文件时每份一个） */}
      {sources.map((adapted) => (
        <ChecklistSection
          key={adapted.meta.title}
          adapted={adapted}
          answers={answers}
          evidence={evidence}
          submitted={submitted}
          onAnswer={handleAnswer}
          onEvidence={handleEvidence}
        />
      ))}

      {/* 底部操作 */}
      <div className='flex items-center justify-between gap-12px pt-4px'>
        <Typography.Text type='secondary' style={{ fontSize: 12 }}>
          {t('policyChecklist.footerHint')}
        </Typography.Text>
        <div className='flex items-center gap-10px'>
          <Button onClick={reset}>{t('policyChecklist.reset')}</Button>
          <Button type='primary' onClick={submit} disabled={submitted}>
            {submitted ? t('policyChecklist.submitted') : t('policyChecklist.submit')}
          </Button>
        </div>
      </div>

      {/* 调试信息（临时，交付前移除） */}
      <details style={{ opacity: 0.6, fontSize: 12 }}>
        <summary>{t('policyChecklist.debug')}</summary>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {JSON.stringify(
            {
              selectedDocs,
              sources: sources.map((s) => ({
                title: s.meta.title,
                total: s.conditions.length,
                groups: {
                  veto: s.conditions.filter((c) => c.board === 'veto').length,
                  base: s.conditions.filter((c) => c.board === 'base').length,
                  bonus: s.conditions.filter((c) => c.board === 'bonus').length,
                  other: s.conditions.filter((c) => c.board === 'other').length,
                },
              })),
            },
            null,
            2
          )}
        </pre>
      </details>
    </div>
  );
};

export default PolicyChecklistPage;
