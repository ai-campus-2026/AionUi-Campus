// ========== 申请清单页：控件分发（按 input_kind 渲染，不做中文语义判断） ==========
import React from 'react';
import { Button, InputNumber, Select, Switch, Typography, Upload } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { AnswerValue, EvidenceFile, PolicyCondition } from './types';

interface ConditionFieldProps {
  condition: PolicyCondition;
  /** base 板：是否已达标（number/yes_no/upload 各自判定） */
  met?: boolean;
  value: AnswerValue;
  onChange: (value: AnswerValue) => void;
  evidence: EvidenceFile[];
  onEvidenceChange: (files: EvidenceFile[]) => void;
  /** veto 板：switch 表示"是否存在违规情形" */
  vetoMode?: boolean;
}

const ConditionField: React.FC<ConditionFieldProps> = ({
  condition,
  met,
  value,
  onChange,
  evidence,
  onEvidenceChange,
  vetoMode,
}) => {
  const { t } = useTranslation();

  // number：数值输入 + 单位 + 阈值即时比对
  // 不限制小数位（precision）：绩点 3.5、排名 1.67/33.33 等都可能带小数，
  // 输入精度不影响判定（判定由 operator/value 字段决定）。
  if (condition.input_kind === 'number') {
    return (
      <div className='flex items-center gap-8px flex-wrap'>
        <InputNumber
          value={typeof value === 'number' ? value : undefined}
          onChange={(v) => onChange(typeof v === 'number' ? v : null)}
          placeholder={t('policyChecklist.field.enterValue')}
          style={{ width: 160 }}
          min={0}
        />
        {condition.unit && condition.unit !== 'none' && (
          <Typography.Text type='secondary' style={{ fontSize: 13 }}>
            {condition.unit}
          </Typography.Text>
        )}
        {condition.quantifiable && condition.requirement && (
          <Typography.Text type='secondary' style={{ fontSize: 12 }}>
            {t('policyChecklist.field.requirement')}：{condition.operator === '>=' ? '≥' : condition.operator === '<=' ? '≤' : condition.operator}{' '}
            {condition.value}
            {condition.unit && condition.unit !== 'none' ? condition.unit : ''}
          </Typography.Text>
        )}
        {met !== undefined && typeof value === 'number' && (
          <span
            className='px-8px py-2px rd-999px'
            style={{
              fontSize: 12,
              color: met ? 'var(--color-success-6)' : 'var(--color-danger-6)',
              background: met ? 'var(--color-success-1)' : 'var(--color-danger-1)',
            }}
          >
            {met ? t('policyChecklist.status.met') : t('policyChecklist.status.notMet')}
          </span>
        )}
      </div>
    );
  }

  // yes_no：veto 板 = "是否存在违规"开关；base 板 = "是否满足"确认
  if (condition.input_kind === 'yes_no') {
    const checked = value === true;
    return (
      <div className='flex items-center gap-10px flex-wrap'>
        <Switch
          checked={checked}
          onChange={(v) => onChange(v)}
          checkedText={t('policyChecklist.field.yes')}
          uncheckedText={t('policyChecklist.field.no')}
        />
        <Typography.Text type='secondary' style={{ fontSize: 13 }}>
          {vetoMode
            ? t('policyChecklist.field.vetoHint')
            : t('policyChecklist.field.baseConfirmHint')}
        </Typography.Text>
        {met !== undefined && checked && (
          <span
            className='px-8px py-2px rd-999px'
            style={{
              fontSize: 12,
              color: 'var(--color-success-6)',
              background: 'var(--color-success-1)',
            }}
          >
            {t('policyChecklist.status.met')}
          </span>
        )}
      </div>
    );
  }

  // upload：材料上传卡（上传即视为已提交；不真正上传，仅记录文件名）
  if (condition.input_kind === 'upload') {
    return (
      <div className='flex items-center gap-10px flex-wrap'>
        <Upload
          multiple
          limit={5}
          customRequest={(option) => {
            // mock 上传：不发送，仅保留文件名
            setTimeout(() => option.onSuccess?.({} as never), 50);
          }}
          onChange={(fileList) => {
            const files: EvidenceFile[] = (fileList ?? [])
              .map((f) => f.originFile?.name ?? f.name)
              .filter(Boolean)
              .map((name) => ({ name }));
            onEvidenceChange(files);
          }}
        >
          <Button size='small'>{t('policyChecklist.field.uploadButton')}</Button>
        </Upload>
        {evidence.length > 0 && (
          <Typography.Text style={{ fontSize: 12, color: 'var(--color-success-6)' }}>
            {t('policyChecklist.field.uploaded')} {evidence.length}{t('policyChecklist.field.uploadedUnit')}
          </Typography.Text>
        )}
      </div>
    );
  }

  // select：档位选择（选项由后端 annotator 提供；缺失时用通用 是/否 兜底）
  if (condition.input_kind === 'select') {
    const options = condition.options?.length
      ? condition.options.map((o) => ({ label: o, value: o }))
      : [
          { label: t('policyChecklist.field.yes'), value: 'yes' },
          { label: t('policyChecklist.field.no'), value: 'no' },
        ];
    return (
      <div className='flex items-center gap-8px flex-wrap'>
        <Select
          value={typeof value === 'string' ? value : undefined}
          onChange={(v) => onChange(typeof v === 'string' ? v : null)}
          placeholder={t('policyChecklist.field.selectPlaceholder')}
          style={{ width: 200 }}
          options={options}
        />
        {met !== undefined && value && (
          <span
            className='px-8px py-2px rd-999px'
            style={{
              fontSize: 12,
              color: 'var(--color-success-6)',
              background: 'var(--color-success-1)',
            }}
          >
            {t('policyChecklist.status.met')}
          </span>
        )}
      </div>
    );
  }

  // none / 未知：纯展示，不渲染控件
  return null;
};

export default ConditionField;
