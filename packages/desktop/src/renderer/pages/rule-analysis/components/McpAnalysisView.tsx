import React, { useMemo, useState } from 'react';
import { CheckOne, CloseOne, Attention, Book, Send, Up, Down } from '@icon-park/react';
import type { CampusRuleToolResult } from '@renderer/components/campus-rule/types';
import { groupsFromMcp, summaryFromGroups } from '../model';
import { guessFieldKey } from '../engine';
import type { AnalysisConditionGroup, AnalysisConditionRow, AnalysisSummary, RowControl } from '../model';

// ---------- 状态元数据（纯字段映射，不做判断） ----------
const STATE_META: Record<
  AnalysisConditionRow['match'],
  { badge: string; text: string; icon: React.ComponentType<{ size?: number | string; theme?: string; fill?: string | string[] }> }
> = {
  met: { badge: 'ra-cond__badge--met', text: '已满足', icon: CheckOne },
  missing_info: { badge: 'ra-cond__badge--missing', text: '待确认', icon: Attention },
  not_met: { badge: 'ra-cond__badge--notmet', text: '未满足', icon: CloseOne },
  needs_manual_review: { badge: 'ra-cond__badge--missing', text: '需核实', icon: Attention },
};

// ---------- 控件渲染（完全由后端 control 字段决定） ----------
const RowControlWidget: React.FC<{
  control?: RowControl;
  onSubmit?: (fieldKey: string, value: string) => void;
}> = ({ control, onSubmit }) => {
  const [draft, setDraft] = useState('');
  if (!control || control.type === 'text') return null;

  const submit = () => {
    const v = draft.trim();
    if (!v || !control.fieldKey || !onSubmit) return;
    onSubmit(control.fieldKey, v);
    setDraft('');
  };

  if (control.type === 'select') {
    return (
      <div className='ra-cond__inline'>
        <select
          className='ra-cond__input'
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label='选择'
        >
          <option value=''>{control.placeholder ?? '请选择'}</option>
          {control.options?.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
        <button type='button' className='ra-cond__send' onClick={submit} disabled={!draft} aria-label='提交'>
          <Send size={14} theme='outline' fill='currentColor' />
        </button>
      </div>
    );
  }

  // input / number / date 统一用 input，type 由后端决定
  return (
    <div className='ra-cond__inline'>
      <input
        className='ra-cond__input'
        type={control.type === 'number' ? 'number' : control.type === 'date' ? 'date' : 'text'}
        value={draft}
        placeholder={control.placeholder ?? '直接填写'}
        aria-label='补充信息'
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button type='button' className='ra-cond__send' onClick={submit} disabled={!draft.trim()} aria-label='提交'>
        <Send size={14} theme='outline' fill='currentColor' />
      </button>
    </div>
  );
};

// ---------- 单条条件卡片（纯字段渲染） ----------
const ConditionCard: React.FC<{
  row: AnalysisConditionRow;
  onSupply?: (fieldKey: string, value: string) => void;
}> = ({ row, onSupply }) => {
  const [basisOpen, setBasisOpen] = useState(false);
  // 用户临时输入的值（输入后立刻显示，不用等重新分析）
  const [localValue, setLocalValue] = useState<string | null>(null);
  const meta = STATE_META[row.match] ?? STATE_META.needs_manual_review;
  const Icon = meta.icon;
  const isMissing = row.match === 'missing_info' || row.match === 'needs_manual_review';
  // 缺失条件默认显示内嵌输入框：有 control 用 control，没有则用 guessFieldKey 推断字段
  const inferredKey = guessFieldKey(row.item);
  const effectiveControl: RowControl | undefined = row.control ?? (
    inferredKey ? { type: 'input', fieldKey: inferredKey, placeholder: `直接填写${row.item}` } : undefined
  );
  const showControl = isMissing && !!onSupply && !!effectiveControl && effectiveControl.type !== 'text';
  // 输入后临时显示用户填的值
  const displayValue = localValue ?? row.userValue;

  const handleSupply = (fieldKey: string, value: string) => {
    setLocalValue(value); // 立刻更新卡片上的显示
    onSupply?.(fieldKey, value); // 同时传给父组件更新我的信息
  };

  return (
    <div className='ra-cond'>
      <span className={`ra-cond__icon ra-cond__icon--${row.match}`}>
        <Icon size={15} theme='outline' fill='currentColor' />
      </span>
      <div className='ra-cond__body'>
        <div className='ra-cond__row1'>
          <span className='ra-cond__name'>{row.item}</span>
          <span className={`ra-cond__badge ${meta.badge}`}>{meta.text}</span>
          {localValue && <span style={{ fontSize: 11, color: '#7f9d78', marginLeft: 6 }}>已更新</span>}
        </div>
        <div className='ra-cond__kv'>
          <div className='ra-cond__kvitem'>
            <div className='ra-cond__k'>当前</div>
            <div className={`ra-cond__v${isMissing && !displayValue ? ' ra-cond__v--empty' : ''}`} style={localValue ? { color: '#648b80', fontWeight: 500 } : undefined}>
              {displayValue || '未提供'}
            </div>
          </div>
          <div className='ra-cond__kvitem'>
            <div className='ra-cond__k'>政策要求</div>
            <div className='ra-cond__v'>{row.requirement ?? '—'}</div>
          </div>
        </div>

        {showControl && <RowControlWidget control={effectiveControl} onSubmit={handleSupply} />}

        {basisOpen && row.sourceQuote && (
          <div className='ra-basis'>
            <div className='ra-basis__quote'>"{row.sourceQuote}"</div>
            {row.sourceFile && <div className='ra-basis__src'>{row.sourceFile}</div>}
          </div>
        )}
      </div>
      <div className='ra-cond__actions'>
        {row.sourceQuote && (
          <button type='button' className='ra-btn ra-btn--ghost' onClick={() => setBasisOpen((v) => !v)}>
            <Book size={13} theme='outline' fill='currentColor' />
            政策依据
            {basisOpen ? <Up size={11} theme='outline' fill='currentColor' /> : <Down size={11} theme='outline' fill='currentColor' />}
          </button>
        )}
      </div>
    </div>
  );
};

// ---------- 横向板块链路 ----------
const GroupChain: React.FC<{
  groups: AnalysisConditionGroup[];
  active: number;
  onSelect: (i: number) => void;
}> = ({ groups, active, onSelect }) => {
  if (groups.length === 0) return null;
  return (
    <div className='ra-chain'>
      {groups.map((g, i) => {
        const missing = g.rows.filter((r) => r.match === 'missing_info' || r.match === 'needs_manual_review').length;
        const notMet = g.rows.filter((r) => r.match === 'not_met').length;
        const stateIcon = notMet > 0 ? '×' : missing > 0 ? '!' : '✓';
        const dotCls = notMet > 0 ? 'ra-chain__dot--notmet' : missing > 0 ? 'ra-chain__dot--missing' : 'ra-chain__dot--met';
        return (
          <React.Fragment key={g.id}>
            {i > 0 && <div className='ra-chain__link' />}
            <button
              type='button'
              className={`ra-chain__node ra-chain__node--section${i === active ? ' ra-chain__node--active' : ''}`}
              onClick={() => onSelect(i)}
            >
              <span className={`ra-chain__dot ${dotCls}`}>{stateIcon}</span>
              <span className='ra-chain__label'>{g.label}</span>
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
};

// ---------- 汇总数字 ----------
const SummaryNumbers: React.FC<{ summary: AnalysisSummary }> = ({ summary }) => (
  <div className='ra-summary-wrap'>
    <div className='ra-summary__title'>匹配结果</div>
    <div className='ra-summary'>
      <div className='ra-summary__cell'>
        <div className='ra-summary__num ra-summary__num--met'>
          {summary.met}<span className='ra-summary__unit'>项满足</span>
        </div>
        <div className='ra-summary__sub ra-summary__sub--met'>✓ 已满足</div>
      </div>
      <div className='ra-summary__cell'>
        <div className='ra-summary__num ra-summary__num--missing'>
          {summary.missing + summary.review}<span className='ra-summary__unit'>项待确认</span>
        </div>
        <div className='ra-summary__sub ra-summary__sub--missing'>! 缺少信息</div>
      </div>
      <div className='ra-summary__cell'>
        <div className='ra-summary__num ra-summary__num--notmet'>
          {summary.notMet}<span className='ra-summary__unit'>项未满足</span>
        </div>
        <div className='ra-summary__sub ra-summary__sub--notmet'>× 暂不符合</div>
      </div>
    </div>
  </div>
);

// ---------- 主视图：MCP 数据驱动的政策解读页面 ----------
const McpAnalysisView: React.FC<{
  result: CampusRuleToolResult;
  question?: string;
  onSupply?: (fieldKey: string, value: string) => void;
}> = ({ result, question, onSupply }) => {
  const [activeGroup, setActiveGroup] = useState(0);

  const groups = useMemo(() => groupsFromMcp(result), [result]);
  const summary = useMemo(() => summaryFromGroups(groups), [groups]);

  const activeGroupData = groups[activeGroup] ?? groups[0];

  // 错误/空结果状态：MCP 返回错误或无结构化条件时展示引导
  const isError = result.status === 'error';
  const hasNoConditions = groups.length === 0 && (!result.evidences || result.evidences.length === 0);
  const showGuidance = isError || hasNoConditions;

  if (showGuidance) {
    return (
      <div className='ra-mcp-analysis'>
        {question && <div className='ra-mcp-analysis__question'>{question}</div>}
        <div className='ra-mcp-analysis__guidance'>
          <div className='ra-mcp-analysis__guidance-icon'>!</div>
          <div className='ra-mcp-analysis__guidance-body'>
            <div className='ra-mcp-analysis__guidance-title'>
              {isError && result.error ? result.error.title : '未能生成结构化分析'}
            </div>
            <div className='ra-mcp-analysis__guidance-desc'>
              {isError && result.error
                ? result.error.description
                : '本次查询可能匹配了多份政策文档，返回内容超出上限被截断。'}
            </div>
            <div className='ra-mcp-analysis__guidance-tip'>
              建议在提问中指明具体政策类型，例如「国家奖学金评定办法」「保研政策」，让系统只匹配一份政策文档后重试。
            </div>
          </div>
        </div>
        {result.summary && <div className='ra-mcp-analysis__conclusion'>{result.summary}</div>}
      </div>
    );
  }

  return (
    <div className='ra-mcp-analysis'>
      {/* 任务标题 */}
      {question && <div className='ra-mcp-analysis__question'>{question}</div>}

      {/* 汇总数字 */}
      {groups.length > 0 && <SummaryNumbers summary={summary} />}

      {/* 结论 */}
      {result.conclusion && (
        <div className='ra-mcp-analysis__conclusion'>
          {result.conclusion}
        </div>
      )}

      {/* 横向板块链路 */}
      {groups.length > 0 && (
        <GroupChain groups={groups} active={activeGroup} onSelect={setActiveGroup} />
      )}

      {/* 当前板块条件卡片 */}
      {activeGroupData && (
        <div className='ra-mcp-analysis__group'>
          <div className='ra-mcp-analysis__group-title'>
            {activeGroupData.label}
            <span className='ra-mcp-analysis__group-count'>{activeGroupData.rows.length} 项</span>
          </div>
          <div className='ra-mcp-analysis__cards'>
            {activeGroupData.rows.map((row) => (
              <ConditionCard key={row.id} row={row} onSupply={onSupply} />
            ))}
          </div>
        </div>
      )}

    </div>
  );
};

export default McpAnalysisView;
