// ========== 申请清单页：① 一票否决确认条 ==========
// 横向排布多条确认项（wrap 换行），默认全部"否"；命中任一 → 前端立即标红短路。
import React from 'react';
import { Typography } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { AnswerValue, PolicyCondition } from './types';
import ConditionField from './ConditionField';

interface VetoStripProps {
  conditions: PolicyCondition[];
  answers: Record<string, AnswerValue>;
  onAnswer: (id: string, value: AnswerValue) => void;
  /** 提交自评后：未命中的否决项标"已确认无此情形"（字段判定：answers[id] !== true） */
  submitted?: boolean;
}

const VetoStrip: React.FC<VetoStripProps> = ({ conditions, answers, onAnswer, submitted }) => {
  const { t } = useTranslation();
  const hitCount = conditions.filter((c) => answers[c.id] === true).length;

  return (
    <section className='flex flex-col gap-10px'>
      <div className='flex items-center gap-8px flex-wrap'>
        <Typography.Title heading={6} style={{ marginBottom: 0 }}>
          {t('policyChecklist.veto.title')}
        </Typography.Title>
        <span
          className='px-8px py-2px rd-999px'
          style={{
            fontSize: 12,
            color: hitCount > 0 ? 'var(--color-danger-6)' : 'var(--color-text-3)',
            background: hitCount > 0 ? 'var(--color-danger-1)' : 'var(--color-fill-3)',
          }}
        >
          {hitCount > 0 ? `${t('policyChecklist.veto.hit')} ${hitCount}` : t('policyChecklist.veto.none')}
        </span>
      </div>
      <Typography.Text type='secondary' style={{ fontSize: 13 }}>
        {t('policyChecklist.veto.desc')}
      </Typography.Text>
      <div className='flex flex-wrap gap-8px'>
        {conditions.map((condition) => {
          const hit = answers[condition.id] === true;
          const cleared = submitted === true && !hit;
          return (
            <div
              key={condition.id}
              className='flex items-center gap-8px px-12px py-8px rd-10px'
              style={{
                background: hit ? 'var(--color-danger-1)' : cleared ? 'var(--color-success-1)' : 'var(--color-fill-2)',
                border: hit ? '1px solid var(--color-danger-4)' : cleared ? '1px solid var(--color-success-4)' : '1px solid transparent',
                transition: 'all 200ms ease',
              }}
            >
              <Typography.Text
                ellipsis
                style={{ maxWidth: 220, fontSize: 13, color: hit ? 'var(--color-danger-6)' : 'var(--color-text-1)' }}
              >
                {condition.item}
              </Typography.Text>
              {cleared && (
                <span
                  className='px-6px py-1px rd-6px'
                  style={{ fontSize: 11, color: 'var(--color-success-6)', background: 'var(--color-success-2)' }}
                >
                  ✓ {t('policyChecklist.veto.cleared')}
                </span>
              )}
              <ConditionField
                condition={condition}
                vetoMode
                value={answers[condition.id]}
                onChange={(v) => onAnswer(condition.id, v)}
                evidence={[]}
                onEvidenceChange={() => {}}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
};

export default VetoStrip;
