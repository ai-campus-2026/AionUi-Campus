// ========== 申请清单页：④ 其他须知（灰色折叠纯展示，不参与判定） ==========
import React from 'react';
import { Collapse, Typography } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { PolicyCondition } from './types';

interface OtherNoticeProps {
  conditions: PolicyCondition[];
}

const OtherNotice: React.FC<OtherNoticeProps> = ({ conditions }) => {
  const { t } = useTranslation();

  if (conditions.length === 0) return null;

  return (
    <section className='flex flex-col gap-10px'>
      <Typography.Title heading={6} style={{ marginBottom: 0 }}>
        {t('policyChecklist.other.title')}
      </Typography.Title>
      <Collapse
        defaultActiveKey={[]}
        bordered={false}
        style={{ background: 'transparent', opacity: 0.75 }}
      >
        {conditions.map((condition) => (
          <Collapse.Item
            key={condition.id}
            name={condition.id}
            header={
              <Typography.Text style={{ fontSize: 13, fontWeight: 500 }}>
                {condition.item}
              </Typography.Text>
            }
          >
            <div className='flex flex-col gap-6px'>
              <Typography.Text type='secondary' style={{ fontSize: 13 }}>
                {condition.description}
              </Typography.Text>
              {condition.source_quote && (
                <Typography.Text
                  type='secondary'
                  style={{ fontSize: 12, lineHeight: 1.7, background: 'var(--color-fill-2)', padding: '8px 12px', borderRadius: 8 }}
                >
                  “{condition.source_quote}”
                </Typography.Text>
              )}
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

export default OtherNotice;
