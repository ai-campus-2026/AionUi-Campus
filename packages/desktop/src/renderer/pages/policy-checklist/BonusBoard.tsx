// ========== 申请清单页：③ 加分项（可折叠 + 材料提供情况） ==========
// 加分项的真实分值依赖细则附件，后端 agent 终判返回 bonus_total；前端只展示条目与提供情况。
import React from 'react';
import { Collapse, Typography } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { AnswerValue, EvidenceFile, EvidenceMap, PolicyCondition } from './types';
import ConditionField from './ConditionField';

interface BonusBoardProps {
  conditions: PolicyCondition[];
  answers: Record<string, AnswerValue>;
  evidence: EvidenceMap;
  onAnswer: (id: string, value: AnswerValue) => void;
  onEvidence: (id: string, files: EvidenceFile[]) => void;
  /** 提交自评后：未提供材料的加分项标"未提供"（字段判定：evidence 是否存在） */
  submitted?: boolean;
}

const BonusBoard: React.FC<BonusBoardProps> = ({ conditions, answers, evidence, onAnswer, onEvidence, submitted }) => {
  const { t } = useTranslation();
  const provided = conditions.filter((c) => (evidence[c.id]?.length ?? 0) > 0).length;

  if (conditions.length === 0) return null;

  return (
    <section className='flex flex-col gap-10px'>
      <div className='flex items-center gap-8px flex-wrap'>
        <Typography.Title heading={6} style={{ marginBottom: 0 }}>
          {t('policyChecklist.bonus.title')}
        </Typography.Title>
        <Typography.Text type='secondary' style={{ fontSize: 13 }}>
          {t('policyChecklist.bonus.provided', { provided, total: conditions.length })}
        </Typography.Text>
        <span
          className='px-8px py-2px rd-999px'
          style={{ fontSize: 12, color: 'var(--color-text-3)', background: 'var(--color-fill-3)' }}
        >
          {t('policyChecklist.bonus.hint')}
        </span>
      </div>

      <Collapse defaultActiveKey={conditions.map((c) => c.id)} bordered={false} style={{ background: 'transparent' }}>
        {conditions.map((condition) => (
          <Collapse.Item
            key={condition.id}
            name={condition.id}
            header={
              <div className='flex items-center gap-8px flex-wrap'>
                <Typography.Text style={{ fontSize: 13, fontWeight: 500 }}>{condition.item}</Typography.Text>
                {(evidence[condition.id]?.length ?? 0) > 0 && (
                  <span
                    className='px-6px py-1px rd-6px'
                    style={{ fontSize: 11, color: 'var(--color-success-6)', background: 'var(--color-success-1)' }}
                  >
                    {t('policyChecklist.bonus.providedTag')}
                  </span>
                )}
                {submitted === true && (evidence[condition.id]?.length ?? 0) === 0 && (
                  <span
                    className='px-6px py-1px rd-6px'
                    style={{ fontSize: 11, color: 'var(--color-warning-6)', background: 'var(--color-warning-1)' }}
                  >
                    ⚠ {t('policyChecklist.bonus.notProvidedTag')}
                  </span>
                )}
              </div>
            }
          >
            <div className='flex flex-col gap-8px'>
              <Typography.Text type='secondary' style={{ fontSize: 13 }}>
                {condition.description}
              </Typography.Text>
              {condition.variants && condition.variants.length > 0 && (
                <div
                  className='flex flex-col gap-4px rd-8px'
                  style={{ padding: '6px 10px', background: 'var(--color-fill-2)' }}
                >
                  <Typography.Text type='secondary' style={{ fontSize: 12 }}>
                    {t('policyChecklist.bonus.variants', { count: condition.variants.length })}
                  </Typography.Text>
                  {condition.variants.map((variant, i) => (
                    <div key={i} className='flex items-baseline gap-6px flex-wrap'>
                      <Typography.Text style={{ fontSize: 12 }}>{variant.requirement || variant.description}</Typography.Text>
                      {variant.source_section && (
                        <Typography.Text type='secondary' style={{ fontSize: 11 }}>
                          {t('policyChecklist.sourceSection')} {variant.source_section}
                        </Typography.Text>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <ConditionField
                condition={condition}
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
          </Collapse.Item>
        ))}
      </Collapse>
    </section>
  );
};

export default BonusBoard;
