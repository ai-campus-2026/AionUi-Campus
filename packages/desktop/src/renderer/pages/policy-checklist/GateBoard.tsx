// ========== 申请清单页：② 基础门槛（逐条卡片 + 即时校验 + 完成度） ==========
import React from 'react';
import { Progress, Typography } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { AnswerValue, EvidenceFile, EvidenceMap, PolicyCondition } from './types';
import ConditionField from './ConditionField';

interface GateBoardProps {
  conditions: PolicyCondition[];
  answers: Record<string, AnswerValue>;
  evidence: EvidenceMap;
  onAnswer: (id: string, value: AnswerValue) => void;
  onEvidence: (id: string, files: EvidenceFile[]) => void;
  metMap: Record<string, boolean>;
  /** 提交自评后：已达标项标"已确认"，未达标项标"待确认"（纯字段判定，无中文语义） */
  submitted?: boolean;
}

const GateBoard: React.FC<GateBoardProps> = ({ conditions, answers, evidence, onAnswer, onEvidence, metMap, submitted }) => {
  const { t } = useTranslation();
  const metCount = conditions.filter((c) => metMap[c.id]).length;
  const percent = conditions.length === 0 ? 0 : Math.round((metCount / conditions.length) * 100);

  return (
    <section className='flex flex-col gap-12px'>
      <div className='flex items-center gap-10px flex-wrap'>
        <Typography.Title heading={6} style={{ marginBottom: 0 }}>
          {t('policyChecklist.base.title')}
        </Typography.Title>
        <Typography.Text type='secondary' style={{ fontSize: 13 }}>
          {t('policyChecklist.base.progress', { met: metCount, total: conditions.length })}
        </Typography.Text>
        <div style={{ width: 160 }}>
          <Progress percent={percent} size='small' />
        </div>
      </div>

      <div className='flex flex-col gap-8px'>
        {conditions.map((condition) => {
          const met = metMap[condition.id];
          // 提交后状态：已达标 → 绿；未达标 → 橙（待确认）。全部由 metMap（字段判定）驱动
          const confirmed = submitted === true && met;
          const pending = submitted === true && !met;
          return (
            <div
              key={condition.id}
              className='flex flex-col gap-6px p-14px rd-12px'
              style={{
                background: confirmed
                  ? 'var(--color-success-1)'
                  : pending
                    ? 'var(--color-warning-1)'
                    : 'var(--color-bg-2)',
                border: confirmed
                  ? '1px solid var(--color-success-4)'
                  : pending
                    ? '1px solid var(--color-warning-4)'
                    : met
                      ? '1px solid var(--color-success-3)'
                      : '1px solid var(--color-border-2)',
                transition: 'all 200ms ease',
              }}
            >
              <div className='flex items-center gap-8px flex-wrap'>
                <Typography.Text style={{ fontSize: 14, fontWeight: 500 }}>
                  {condition.item}
                </Typography.Text>
                {confirmed && (
                  <span
                    className='px-6px py-1px rd-6px'
                    style={{ fontSize: 11, color: 'var(--color-success-6)', background: 'var(--color-success-2)' }}
                  >
                    ✓ {t('policyChecklist.status.confirmed')}
                  </span>
                )}
                {pending && (
                  <span
                    className='px-6px py-1px rd-6px'
                    style={{ fontSize: 11, color: 'var(--color-warning-6)', background: 'var(--color-warning-2)' }}
                  >
                    ⚠ {t('policyChecklist.status.pending')}
                  </span>
                )}
                {condition.type !== 'hard' && (
                  <span
                    className='px-6px py-1px rd-6px'
                    style={{ fontSize: 11, color: 'var(--color-text-3)', background: 'var(--color-fill-3)' }}
                  >
                    {condition.type === 'scoring' ? t('policyChecklist.tag.scoring') : t('policyChecklist.tag.procedural')}
                  </span>
                )}
                {condition.requires_evidence && (
                  <span
                    className='px-6px py-1px rd-6px'
                    style={{ fontSize: 11, color: 'var(--color-text-3)', background: 'var(--color-fill-3)' }}
                  >
                    {t('policyChecklist.tag.needEvidence')}
                  </span>
                )}
              </div>
              <Typography.Text type='secondary' style={{ fontSize: 13 }}>
                {condition.description}
              </Typography.Text>
              <div className='flex items-center justify-between gap-10px flex-wrap'>
                <ConditionField
                  condition={condition}
                  met={met}
                  value={answers[condition.id]}
                  onChange={(v) => onAnswer(condition.id, v)}
                  evidence={evidence[condition.id] ?? []}
                  onEvidenceChange={(files) => onEvidence(condition.id, files)}
                />
                {condition.source_section && (
                  <Typography.Text type='secondary' style={{ fontSize: 12 }}>
                    {t('policyChecklist.sourceSection')} {condition.source_section}
                  </Typography.Text>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};

export default GateBoard;
