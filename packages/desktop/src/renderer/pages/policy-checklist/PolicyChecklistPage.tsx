// ========== 申请清单页：主页面 ==========
// 结构（自上而下）：文档头 → 一票否决确认条 → 基础门槛 → 加分项 → 其他须知
// 判定顺序（与后端一致）：VETO 短路 → BASE 缺口 → BONUS 提供情况
import React, { useMemo, useState } from 'react';
import { Alert, Button, Select, Tag, Typography } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { flattenConditions, groupByBoard, evaluateChecklist, isBaseMet } from './adaptPolicyDoc';
import BonusBoard from './BonusBoard';
import GateBoard from './GateBoard';
import mockPolicyDoc from './mock-policy-doc.json';
import mockScholarshipDoc from './mock-scholarship-doc.json';
import OtherNotice from './OtherNotice';
import VetoStrip from './VetoStrip';
import type { AnswerValue, Answers, EvidenceFile, EvidenceMap, PolicyDoc } from './types';

/** mock 文档注册表：key 与政策知识库 category 对齐；后续接真实 MCP 时替换为运行时加载 */
const DOC_OPTIONS = [
  { key: 'postgraduate_recommendation', labelKey: 'policyChecklist.doc.pg', doc: mockPolicyDoc },
  { key: 'scholarship', labelKey: 'policyChecklist.doc.scholarship', doc: mockScholarshipDoc },
];

const PolicyChecklistPage: React.FC = () => {
  const { t } = useTranslation();

  // 当前选择的政策文档（mock 真实 JSON；后续替换为 MCP 运行时返回，解析逻辑不变）
  const [docKey, setDocKey] = useState(DOC_OPTIONS[0].key);
  const doc = DOC_OPTIONS.find((o) => o.key === docKey)?.doc as unknown as PolicyDoc;

  const allConditions = useMemo(
    () => flattenConditions(doc),
    [doc]
  );
  const groups = useMemo(() => groupByBoard(allConditions), [allConditions]);

  const [answers, setAnswers] = useState<Answers>({});
  const [evidence, setEvidence] = useState<EvidenceMap>({});

  const handleAnswer = (id: string, value: AnswerValue) => {
    setAnswers((prev) => ({ ...prev, [id]: value }));
  };
  const handleEvidence = (id: string, files: EvidenceFile[]) => {
    setEvidence((prev) => ({ ...prev, [id]: files }));
  };

  const switchDoc = (key: string) => {
    setDocKey(key);
    setAnswers({});
    setEvidence({});
  };

  // 即时校验：基础门槛逐条达标状态
  const metMap = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const condition of groups.base) {
      map[condition.id] = isBaseMet(condition, answers[condition.id], evidence);
    }
    return map;
  }, [groups.base, answers, evidence]);

  // 判定（veto 短路 → base 缺口 → 完成）
  const verdict = useMemo(
    () => evaluateChecklist(allConditions, answers, evidence),
    [allConditions, answers, evidence]
  );

  const reset = () => {
    setAnswers({});
    setEvidence({});
  };

  const submit = () => {
    // 阶段 1（mock）：仅提示前端判定结果；真实提交 payload（answers + evidence）等后端通道确认后再接
    // payload 结构（对接文档）：{ doc_id, answers:[{id,input_kind,value}], evidence:{conditionId:[{fileName,url}]} }
    console.log('[PolicyChecklist] submit payload', {
      doc_id: doc.meta.doc_id,
      answers: Object.entries(answers).map(([id, value]) => ({ id, input_kind: allConditions.find((c) => c.id === id)?.input_kind, value })),
      evidence,
    });
  };

  const docMeta = doc.meta;

  return (
    <div className='mx-auto flex flex-col gap-24px pt-40px px-24px pb-48px' style={{ maxWidth: 860 }}>
      {/* 文档头 */}
      <div className='flex flex-col gap-6px'>
        <div className='flex items-center gap-8px flex-wrap'>
          <Select
            value={docKey}
            onChange={switchDoc}
            style={{ width: 240 }}
            options={DOC_OPTIONS.map((o) => ({ label: t(o.labelKey), value: o.key }))}
          />
          <Tag color='arcoblue'>{t('policyChecklist.pageTag')}</Tag>
          {docMeta.tags?.map((tag) => (
            <Tag key={tag} size='small' style={{ opacity: 0.7 }}>
              {tag}
            </Tag>
          ))}
        </div>
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
      <VetoStrip conditions={groups.veto} answers={answers} onAnswer={handleAnswer} />

      {/* ② 基础门槛 + ③ 加分项 + ④ 其他须知（veto 命中时收起） */}
      {verdict.status !== 'disqualified' && (
        <>
          <GateBoard
            conditions={groups.base}
            answers={answers}
            evidence={evidence}
            onAnswer={handleAnswer}
            onEvidence={handleEvidence}
            metMap={metMap}
          />
          <BonusBoard
            conditions={groups.bonus}
            answers={answers}
            evidence={evidence}
            onAnswer={handleAnswer}
            onEvidence={handleEvidence}
          />
        </>
      )}
      <OtherNotice conditions={groups.other} />

      {/* 底部操作 */}
      <div className='flex items-center justify-between gap-12px pt-4px'>
        <Typography.Text type='secondary' style={{ fontSize: 12 }}>
          {t('policyChecklist.footerHint')}
        </Typography.Text>
        <div className='flex items-center gap-10px'>
          <Button onClick={reset}>{t('policyChecklist.reset')}</Button>
          <Button type='primary' onClick={submit} disabled={verdict.status === 'disqualified'}>
            {t('policyChecklist.submit')}
          </Button>
        </div>
      </div>

      {/* 调试信息（临时，交付前移除） */}
      <details style={{ opacity: 0.6, fontSize: 12 }}>
        <summary>{t('policyChecklist.debug')}</summary>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {JSON.stringify(
            {
              total: allConditions.length,
              groups: {
                veto: groups.veto.length,
                base: groups.base.length,
                bonus: groups.bonus.length,
                other: groups.other.length,
              },
              verdict,
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
