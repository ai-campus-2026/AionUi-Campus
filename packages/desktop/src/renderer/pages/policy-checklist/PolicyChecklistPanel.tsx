// ========== 政策清单：对话右侧面板 ==========
// 由 Layout 级预览区 / ChatLayout 预览区挂载；docKey 来自 checklistPanelStore
// （AI 调用 query_policy 时自动打开）。复用与申请自评页相同的判定与板块组件。
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Message, Select, Tag, Typography } from '@arco-design/web-react';
import { FileText } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { flattenConditions, groupByBoard, evaluateChecklist, isBaseMet } from './adaptPolicyDoc';
import BonusBoard from './BonusBoard';
import GateBoard from './GateBoard';
import mockPolicyDoc from './mock-policy-doc.json';
import mockScholarshipDoc from './mock-scholarship-doc.json';
import OtherNotice from './OtherNotice';
import VetoStrip from './VetoStrip';
import type { AnswerValue, Answers, EvidenceFile, EvidenceMap, PolicyDoc } from './types';
import { usePolicyChecklistPanel, type ChecklistDocKey } from './checklistPanelStore';

const DOC_MAP: Record<ChecklistDocKey, { doc: PolicyDoc; labelKey: string }> = {
  scholarship: { doc: mockScholarshipDoc as unknown as PolicyDoc, labelKey: 'policyChecklist.doc.scholarship' },
  postgraduate_recommendation: { doc: mockPolicyDoc as unknown as PolicyDoc, labelKey: 'policyChecklist.doc.pg' },
};

/** 无工具触发时的默认文档 */
const DEFAULT_DOC_KEY: ChecklistDocKey = 'postgraduate_recommendation';

const PolicyChecklistPanel: React.FC = () => {
  const { t } = useTranslation();
  const { docKey, hints, closeChecklist, openChecklist } = usePolicyChecklistPanel();

  // 无触发时回退默认文档；工具触发（store.docKey）时自动跟随
  const currentKey: ChecklistDocKey = docKey ?? DEFAULT_DOC_KEY;
  const doc = DOC_MAP[currentKey].doc;

  const allConditions = useMemo(() => (doc ? flattenConditions(doc) : []), [doc]);
  const groups = useMemo(() => groupByBoard(allConditions), [allConditions]);

  const [answers, setAnswers] = useState<Answers>({});
  const [evidence, setEvidence] = useState<EvidenceMap>({});
  const [submitted, setSubmitted] = useState(false);
  const [messageApi, messageContext] = Message.useMessage();

  // 文档变化（工具触发 / 手动切换）时清空作答，避免跨文档残留
  const [renderedDocKey, setRenderedDocKey] = useState<ChecklistDocKey>(currentKey);
  if (currentKey !== renderedDocKey) {
    setRenderedDocKey(currentKey);
    setAnswers({});
    setEvidence({});
    setSubmitted(false);
  }

  // 对话预填：AI 触发清单时，把问题里提到的信息（绩点/排名/义工时长等）
  // 自动填入对应条件。只填用户尚未手填的项（不覆盖手填，幂等）；
  // 依赖 [currentKey, hints] 保证文档/提示变化时重新应用，跨文档切换不丢预填。
  useEffect(() => {
    if (!doc || Object.keys(hints).length === 0) return;
    setAnswers((prev) => {
      const next = { ...prev };
      for (const [itemName, value] of Object.entries(hints)) {
        const condition = allConditions.find((c) => c.item === itemName && next[c.id] === undefined);
        if (condition) next[condition.id] = value;
      }
      return next;
    });
  }, [doc, currentKey, hints, allConditions]);

  const handleAnswer = (id: string, value: AnswerValue) => {
    setSubmitted(false);
    setAnswers((prev) => ({ ...prev, [id]: value }));
  };
  const handleEvidence = (id: string, files: EvidenceFile[]) => {
    setSubmitted(false);
    setEvidence((prev) => ({ ...prev, [id]: files }));
  };

  // 切换文档（下次触发 / 用户重开）时清空作答，避免跨文档残留
  const metMap = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const condition of groups.base) {
      map[condition.id] = isBaseMet(condition, answers[condition.id], evidence);
    }
    return map;
  }, [groups.base, answers, evidence]);

  const verdict = useMemo(
    () => evaluateChecklist(allConditions, answers, evidence),
    [allConditions, answers, evidence]
  );

  const reset = () => {
    setAnswers({});
    setEvidence({});
    setSubmitted(false);
  };

  const submit = () => {
    if (verdict.status === 'disqualified' || submitted) return;
    setSubmitted(true);
    // mock 阶段：仅前端反馈 + 打印 payload；真实提交（answers + evidence 到后端）待通道确认后接入
    console.log('[PolicyChecklistPanel] submit payload', {
      doc_id: docMeta.doc_id,
      answers: Object.entries(answers).map(([id, value]) => ({
        id,
        input_kind: allConditions.find((c) => c.id === id)?.input_kind,
        value,
      })),
      evidence,
    });
    messageApi.success(t('policyChecklist.submitDone', { met: verdict.metCount, total: verdict.baseTotal }));
  };

  if (!doc) return null;
  const docMeta = doc.meta;

  return (
    <div className='flex h-full w-full flex-col bg-1' style={{ minWidth: 0 }}>
      {messageContext}
      {/* 头部：文档切换 + 标题 */}
      <div className='flex items-start justify-between gap-8px px-14px pt-12px pb-8px shrink-0'>
        <div className='flex items-center gap-6px min-w-0'>
          <FileText theme='outline' size='15' className='shrink-0 opacity-70' />
          <Select
            value={currentKey}
            onChange={(key) => openChecklist(key as ChecklistDocKey)}
            size='mini'
            style={{ width: 104 }}
            options={(
              Object.keys(DOC_MAP) as ChecklistDocKey[]
            ).map((key) => ({ label: t(DOC_MAP[key].labelKey), value: key }))}
          />
        </div>
        <Typography.Text style={{ fontSize: 13, fontWeight: 600 }} ellipsis={{ rows: 2 }}>
          {docMeta.title}
        </Typography.Text>
      </div>
      <div className='flex items-center gap-6px px-14px pb-8px shrink-0 flex-wrap'>
        <Tag color='arcoblue' size='small'>
          {t(DOC_MAP[currentKey].labelKey)}
        </Tag>
        {docMeta.tags?.slice(0, 3).map((tag) => (
          <Tag key={tag} size='small' style={{ opacity: 0.65 }}>
            {tag}
          </Tag>
        ))}
        <Typography.Text type='secondary' style={{ fontSize: 11 }}>
          {docMeta.effective_date}
        </Typography.Text>
      </div>

      {/* 判定结果条 */}
      {verdict.status === 'disqualified' && (
        <Alert
          type='error'
          style={{ margin: '0 14px 10px' }}
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
          style={{ margin: '0 14px 10px' }}
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
          style={{ margin: '0 14px 10px' }}
          title={t('policyChecklist.verdict.qualified')}
          content={t('policyChecklist.verdict.qualifiedDesc', { bonus: verdict.bonusProvided })}
        />
      )}

      {/* 四板块（veto 短路收起下方） */}
      <div className='flex-1 overflow-y-auto px-14px pb-16px'>
        <VetoStrip conditions={groups.veto} answers={answers} onAnswer={handleAnswer} submitted={submitted} />
        {verdict.status !== 'disqualified' && (
          <>
            <GateBoard
              conditions={groups.base}
              answers={answers}
              evidence={evidence}
              onAnswer={handleAnswer}
              onEvidence={handleEvidence}
              metMap={metMap}
              submitted={submitted}
            />
            <BonusBoard
              conditions={groups.bonus}
              answers={answers}
              evidence={evidence}
              onAnswer={handleAnswer}
              onEvidence={handleEvidence}
              submitted={submitted}
            />
          </>
        )}
        <OtherNotice conditions={groups.other} />
      </div>

      {/* 底部操作 */}
      <div className='flex items-center justify-between gap-10px px-14px py-10px shrink-0 border-t' style={{ borderColor: 'var(--border-base)' }}>
        <Typography.Text type='secondary' style={{ fontSize: 11 }}>
          {t('policyChecklist.footerHint')}
        </Typography.Text>
        <div className='flex items-center gap-8px'>
          <Button size='mini' onClick={reset} disabled={submitted}>
            {t('policyChecklist.reset')}
          </Button>
          <Button size='mini' type='primary' disabled={verdict.status === 'disqualified' || submitted} onClick={submit}>
            {submitted ? t('policyChecklist.submitted') : t('policyChecklist.submit')}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default PolicyChecklistPanel;
