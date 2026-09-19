import React, { useState } from 'react';
import { CheckOne, CloseOne, Attention, LoadingOne, Book, Send, Up, Down } from '@icon-park/react';
import type { MatchResult, UiConditionState } from '../model';

const STATE_META: Record<
  UiConditionState,
  { badge: string; text: string; icon: React.ComponentType<{ size?: number | string; theme?: string; fill?: string | string[] }> }
> = {
  met: { badge: 'ra-cond__badge--met', text: '已满足', icon: CheckOne },
  missing: { badge: 'ra-cond__badge--missing', text: '待确认', icon: Attention },
  not_met: { badge: 'ra-cond__badge--notmet', text: '未满足', icon: CloseOne },
  analyzing: { badge: 'ra-cond__badge--analyzing', text: '分析中', icon: LoadingOne },
};

/**
 * 单条条件卡片：状态徽章 + 当前值/政策要求 + 政策依据。
 * 待确认（信息缺失）的卡片直接内嵌输入框，填完回车即同步到「我的信息」。
 */
const ConditionCard: React.FC<{
  row: MatchResult;
  state: UiConditionState;
  /** 为 true 时状态徽章播放“变化”动画（重新分析后） */
  pop?: boolean;
  /** 底部输入引导（缺字段的卡片已改为内嵌输入，此按钮仅无字段映射时保留） */
  onSupplement?: (item: string) => void;
  /** 该条件依赖的字段（用于内嵌输入） */
  fieldKey?: string;
  fieldHint?: string;
  onSupply?: (fieldKey: string, value: string) => void;
}> = ({ row, state, pop, onSupplement, fieldKey, fieldHint, onSupply }) => {
  const [basisOpen, setBasisOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const meta = STATE_META[state];
  const Icon = meta.icon;
  const analyzing = state === 'analyzing';
  const missing = row.state === 'missing' || (analyzing && row.userValue === '未提供');

  const showInline = row.state === 'missing' && !analyzing && !!fieldKey && !!onSupply;

  const submitInline = () => {
    const v = draft.trim();
    if (!v || !fieldKey || !onSupply) return;
    onSupply(fieldKey, v);
    setDraft('');
  };

  return (
    <div className={`ra-cond${analyzing ? ' ra-cond--analyzing' : ''}`}>
      <span className={`ra-cond__icon ra-cond__icon--${analyzing ? 'analyzing' : row.state}`}>
        <Icon size={15} theme='outline' fill='currentColor' />
      </span>

      <div className='ra-cond__body'>
        <div className='ra-cond__row1'>
          <span className='ra-cond__name'>{row.item}</span>
          <span className={`ra-cond__badge ${meta.badge}${pop && !analyzing ? ' ra-cond__badge--pop' : ''}`}>
            {meta.text}
          </span>
        </div>
        <div className='ra-cond__kv'>
          <div className='ra-cond__kvitem'>
            <div className='ra-cond__k'>当前</div>
            <div className={`ra-cond__v${missing ? ' ra-cond__v--empty' : ''}`}>
              {missing ? '未提供' : row.userValue}
            </div>
          </div>
          <div className='ra-cond__kvitem'>
            <div className='ra-cond__k'>政策要求</div>
            <div className='ra-cond__v'>{row.requirement}</div>
          </div>
        </div>

        {showInline && (
          <div className='ra-cond__inline'>
            <input
              className='ra-cond__input'
              value={draft}
              placeholder={fieldHint ? `直接填写，例如 ${fieldHint}` : '直接填写'}
              aria-label={`补充${row.item}`}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submitInline();
                }
              }}
            />
            <button type='button' className='ra-cond__send' onClick={submitInline} aria-label='提交'>
              <Send size={14} theme='outline' fill='currentColor' />
            </button>
          </div>
        )}

        {basisOpen && (
          <div className='ra-basis'>
            <div className='ra-basis__quote'>“{row.sourceQuote}”</div>
            <div className='ra-basis__src'>{row.sourceFile}</div>
          </div>
        )}
      </div>

      <div className='ra-cond__actions'>
        <button type='button' className='ra-btn ra-btn--ghost' onClick={() => setBasisOpen((v) => !v)}>
          <Book size={13} theme='outline' fill='currentColor' />
          政策依据
          {basisOpen ? <Up size={11} theme='outline' fill='currentColor' /> : <Down size={11} theme='outline' fill='currentColor' />}
        </button>
        {onSupplement && !showInline && (
          <button type='button' className='ra-btn' onClick={() => onSupplement(row.item)}>
            <Send size={13} theme='outline' fill='currentColor' />
            补充信息
          </button>
        )}
      </div>
    </div>
  );
};

export default ConditionCard;
