// ========== 政策清单：对话右侧面板 ==========
// 由 Layout 级预览区 / ChatLayout 预览区挂载；docKey/rawResults/hints/selectedDocs 来自 checklistPanelStore。
// 渲染规则：仅当对话中 AI 调用 query_policy 且解析出实时返回（rawResults）时显示；
// 用户没问问题时（docKey 为 null 或尚无返回）面板不出现。
// 数据链路（真实）：
//   提问 → LLM 调用 query_policy → 后端返回该分类下全部政策的匹配结果（results 数组）
//   → 前端按工作台所选文件（标题）过滤 → 渲染所选文件的真实判定清单；未选文件则渲染全部。
// 前端只按字段渲染，不做中文语义判断。
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Message, Tag, Typography } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { groupByBoard, evaluateChecklist, isBaseMet } from './adaptPolicyDoc';
import { adaptQueryPolicyResult, isBackendMet, type AdaptedChecklist } from './adaptQueryPolicyResult';
import BonusBoard from './BonusBoard';
import GateBoard from './GateBoard';
import OtherNotice from './OtherNotice';
import VetoStrip from './VetoStrip';
import type { AnswerValue, Answers, EvidenceFile, EvidenceMap, PolicyCondition } from './types';
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

/** 单份政策清单（多份时每份一个区块） */
const ChecklistSections: React.FC<{
  adapted: AdaptedChecklist;
  answers: Answers;
  evidence: EvidenceMap;
  submitted: boolean;
  onAnswer: (id: string, value: AnswerValue) => void;
  onEvidence: (id: string, files: EvidenceFile[]) => void;
}> = ({ adapted, answers, evidence, submitted, onAnswer, onEvidence }) => {
  const { t } = useTranslation();
  const allConditions = adapted.conditions;
  const docMeta = adapted.meta;
  const verdict = adapted.verdict;
  const groups = useMemo(() => groupByBoard(allConditions), [allConditions]);

  const metMap = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const condition of groups.base) {
      map[condition.id] = isFilled(condition, answers[condition.id], evidence)
        ? isBaseMet(condition, answers[condition.id], evidence)
        : isBackendMet(condition.backendMatch);
    }
    return map;
  }, [groups.base, answers, evidence]);

  return (
    <section className='flex flex-col gap-10px'>
      {/* 文档标题 */}
      <div className='flex flex-col gap-4px'>
        <Typography.Text style={{ fontSize: 13, fontWeight: 600 }} ellipsis={{ rows: 2 }}>
          {docMeta.title}
        </Typography.Text>
        <Typography.Text type='secondary' style={{ fontSize: 11 }}>
          {docMeta.school} · {docMeta.source_file}
        </Typography.Text>
      </div>

      {verdict.status === 'disqualified' && (
        <Alert
          type='error'
          title={t('policyChecklist.verdict.disqualified')}
          content={
            <ul className='m-0 pl-16px'>
              {verdict.hitVetoes.map((c) => (
                <li key={c.id} style={{ fontSize: 12 }}>
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
      <VetoStrip conditions={groups.veto} answers={answers} onAnswer={onAnswer} />
      {verdict.status !== 'disqualified' && (
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
      <OtherNotice conditions={groups.other} />
    </section>
  );
};

const PolicyChecklistPanel: React.FC = () => {
  const { t } = useTranslation();
  const { docKey, hints, rawResults, selectedDocs } = usePolicyChecklistPanel();

  // 实时数据源：完整 results 数组 → 每份政策适配一份清单
  const liveList = useMemo(
    () => (docKey && rawResults ? rawResults.map((r) => adaptQueryPolicyResult(r)) : []),
    [docKey, rawResults]
  );

  // 按工作台所选文件（标题）过滤；未选 → 全部；选了但返回里没有 → 全部（不空白）
  const sources = useMemo(() => {
    if (selectedDocs.length === 0) return liveList;
    const filtered = liveList.filter((a) => selectedDocs.includes(a.meta.title));
    return filtered.length > 0 ? filtered : liveList;
  }, [liveList, selectedDocs]);

  const [answers, setAnswers] = useState<Answers>({});
  const [evidence, setEvidence] = useState<EvidenceMap>({});
  const [submitted, setSubmitted] = useState(false);
  const [messageApi, messageContext] = Message.useMessage();

  // 新一轮实时返回（新的问答）到达时清空作答，避免跨问题残留
  const [renderedRaw, setRenderedRaw] = useState<typeof rawResults>(rawResults);
  if (rawResults !== renderedRaw) {
    setRenderedRaw(rawResults);
    setAnswers({});
    setEvidence({});
    setSubmitted(false);
  }

  // 对话预填：AI 触发清单时，把问题里提到的信息自动填入对应条件（幂等，不覆盖手填）
  const allConditions = useMemo(() => sources.flatMap((s) => s.conditions), [sources]);
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
    setSubmitted(false);
    setAnswers((prev) => ({ ...prev, [id]: value }));
  };
  const handleEvidence = (id: string, files: EvidenceFile[]) => {
    setSubmitted(false);
    setEvidence((prev) => ({ ...prev, [id]: files }));
  };

  const resetAll = () => {
    setAnswers({});
    setEvidence({});
    setSubmitted(false);
  };

  const submit = () => {
    if (submitted) return;
    setSubmitted(true);
    const confirmed = allConditions.filter((c) => isFilled(c, answers[c.id], evidence)).length;
    console.log('[PolicyChecklistPanel] submit payload', {
      docs: sources.map((s) => s.meta.title),
      answers: Object.entries(answers).map(([id, value]) => ({ id, value })),
      evidence,
    });
    messageApi.success(
      t('policyChecklist.submittedSummary', {
        pending: allConditions.length - confirmed,
        confirmed,
      })
    );
  };

  // 没问问题 / 尚无实时返回 → 面板不出现
  if (sources.length === 0) return null;

  return (
    <div className='flex h-full w-full flex-col bg-1' style={{ minWidth: 0 }}>
      {messageContext}
      {/* 头部：实时标记 + 文件标签（所选/全部） */}
      <div className='flex flex-col gap-6px px-14px pt-12px pb-8px shrink-0'>
        <div className='flex items-center gap-6px flex-wrap'>
          <Tag color='green' size='small'>
            {t('policyChecklist.liveTag')}
          </Tag>
          {selectedDocs.length > 0 ? (
            <Tag color='arcoblue' size='small'>
              {t('policyChecklist.multiDocs', { count: sources.length })}
            </Tag>
          ) : (
            <Tag size='small'>{t('policyChecklist.allDocs', { count: sources.length })}</Tag>
          )}
        </div>
        <Typography.Text type='secondary' style={{ fontSize: 11 }}>
          {selectedDocs.length > 0
            ? t('policyChecklist.filterBySelected')
            : t('policyChecklist.followQuestion')}
        </Typography.Text>
      </div>

      {/* 清单区块（多文件时每份一个，可滚动） */}
      <div className='flex-1 overflow-y-auto px-14px pb-16px flex flex-col gap-20px'>
        {sources.map((adapted) => (
          <ChecklistSections
            key={adapted.meta.title}
            adapted={adapted}
            answers={answers}
            evidence={evidence}
            submitted={submitted}
            onAnswer={handleAnswer}
            onEvidence={handleEvidence}
          />
        ))}
      </div>

      {/* 底部操作 */}
      <div className='flex items-center justify-between gap-10px px-14px py-10px shrink-0 border-t' style={{ borderColor: 'var(--border-base)' }}>
        <Typography.Text type='secondary' style={{ fontSize: 11 }}>
          {t('policyChecklist.footerHint')}
        </Typography.Text>
        <div className='flex items-center gap-8px'>
          <Button size='mini' onClick={resetAll} disabled={submitted}>
            {t('policyChecklist.reset')}
          </Button>
          <Button size='mini' type='primary' disabled={submitted} onClick={submit}>
            {submitted ? t('policyChecklist.submitted') : t('policyChecklist.submit')}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default PolicyChecklistPanel;
