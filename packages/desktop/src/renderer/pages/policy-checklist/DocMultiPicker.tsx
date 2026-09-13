// ========== 查询文件多选选择器 ==========
// 用于工作台对话框旁：选择本次要查询的政策文件（多选）。
// 选项由外部传入（工作台读取知识库 index.json 的真实文件，与"规则动态"同源）。
// 选中结果存 checklistPanelStore.selectedDocs，发送问题时作为"查询范围"上下文注入。
import React from 'react';
import { Select } from '@arco-design/web-react';
import { FileText } from '@icon-park/react';
import { useTranslation } from 'react-i18next';

export interface PolicyFileOption {
  label: string;
  value: string;
}

interface Props {
  value: string[];
  onChange: (docs: string[]) => void;
  options: PolicyFileOption[];
  compact?: boolean;
}

/** 查询文件多选：列出知识库真实政策文件（与规则动态同源），支持多选 */
const DocMultiPicker: React.FC<Props> = ({ value, onChange, options, compact }) => {
  const { t } = useTranslation();
  return (
    <div className='flex items-center gap-6px min-w-0' style={{ maxWidth: compact ? '100%' : 420 }}>
      <FileText theme='outline' size={compact ? 13 : 15} className='shrink-0' style={{ opacity: 0.65 }} />
      <Select
        mode='multiple'
        value={value}
        onChange={(next) => onChange(next as string[])}
        size={compact ? 'mini' : 'small'}
        placeholder={t('policyChecklist.docPickerPlaceholder')}
        style={{ width: '100%' }}
        maxTagCount={compact ? 2 : 3}
        options={options}
      />
    </div>
  );
};

export default DocMultiPicker;
