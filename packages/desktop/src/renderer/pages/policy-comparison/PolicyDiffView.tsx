import { Home } from '@icon-park/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { PolicyDiffResult, PolicyChange, ChangeType, SelectedPolicyFile } from './types';

type Props = {
  result: PolicyDiffResult;
  oldFile: SelectedPolicyFile | null;
  newFile: SelectedPolicyFile | null;
  onBack: () => void;
  onHome: () => void;
};

/**
 * 政策变更对照页（Diff 视图）
 * 左右双栏独立滚动，changeId 联动，上一处/下一处导航
 */
const PolicyDiffView: React.FC<Props> = ({ result, oldFile, newFile, onBack, onHome }) => {
  const [activeIndex, setActiveIndex] = useState(0);
  const leftScrollRef = useRef<HTMLDivElement>(null);
  const rightScrollRef = useRef<HTMLDivElement>(null);
  const changeRefs = useRef<Map<string, { left: HTMLDivElement | null; right: HTMLDivElement | null }>>(new Map());

  const changes = result?.changes ?? [];
  const activeChange = changes[activeIndex] ?? null;

  const scrollToChange = useCallback((changeId: string, side: 'left' | 'right' | 'both') => {
    const refs = changeRefs.current.get(changeId);
    if (!refs) return;
    if ((side === 'left' || side === 'both') && refs.left) {
      refs.left.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if ((side === 'right' || side === 'both') && refs.right) {
      refs.right.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, []);

  const selectChange = useCallback(
    (index: number) => {
      if (index < 0 || index >= changes.length) return;
      setActiveIndex(index);
      const change = changes[index];
      if (change) scrollToChange(change.changeId, 'both');
    },
    [changes, scrollToChange]
  );

  const goPrev = useCallback(() => selectChange(activeIndex - 1), [activeIndex, selectChange]);
  const goNext = useCallback(() => selectChange(activeIndex + 1), [activeIndex, selectChange]);

  const handleChangeClick = useCallback(
    (changeId: string, clickedSide: 'left' | 'right') => {
      const idx = changes.findIndex((c) => c.changeId === changeId);
      if (idx >= 0) setActiveIndex(idx);
      const otherSide = clickedSide === 'left' ? 'right' : 'left';
      scrollToChange(changeId, otherSide);
    },
    [changes, scrollToChange]
  );

  const setChangeRef = useCallback((changeId: string, side: 'left' | 'right', el: HTMLDivElement | null) => {
    const existing = changeRefs.current.get(changeId) ?? { left: null, right: null };
    existing[side] = el;
    changeRefs.current.set(changeId, existing);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        goPrev();
      } else if (e.key === 'ArrowRight' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        goNext();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goPrev, goNext]);

  const summary = result?.summary;
  const doc = result?.document;
  const circledNums = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

  const renderChangeBlock = (change: PolicyChange, side: 'left' | 'right', index: number) => {
    const isActive = change.changeId === activeChange?.changeId;
    const content = side === 'left' ? change.old : change.new;
    const isPlaceholder = !content;
    let sideType: ChangeType = change.type;
    if (change.type === 'added' && side === 'left') sideType = 'added';
    if (change.type === 'removed' && side === 'right') sideType = 'removed';

    return (
      <div
        key={`${change.changeId}-${side}`}
        ref={(el) => setChangeRef(change.changeId, side, el)}
        className={`pc-change pc-change--${sideType} ${isActive ? 'pc-change--active' : ''}`}
        onClick={() => handleChangeClick(change.changeId, side)}
      >
        <div className='pc-change__head'>
          <span className='pc-change__num'>{circledNums[index] ?? index + 1}</span>
          <span className='pc-change__section'>
            {content?.section ?? (change.type === 'added' ? '新增条款' : change.type === 'removed' ? '已删除' : '—')}
          </span>
          <span className={`pc-change__tag pc-change__tag--${sideType}`}>
            {change.type === 'modified' ? '修改' : change.type === 'added' ? '新增' : '删除'}
          </span>
        </div>
        {isPlaceholder ? (
          <div className='pc-change__placeholder'>
            {change.type === 'added' && side === 'left' ? '此处为新增内容' : '该内容已删除'}
          </div>
        ) : (
          <div className='pc-change__content'>{content.content}</div>
        )}
        {change.context?.before && change.context.before.length > 0 && (
          <div className='pc-change__context'>
            {change.context.before.map((ctx, i) => (
              <div key={i} className='pc-change__ctx-line'>
                {ctx}
              </div>
            ))}
          </div>
        )}
        {isActive && side === 'right' && change.aiExplanation && (
          <div className='pc-ai-explain'>
            <div className='pc-ai-explain__label'>AI 解读</div>
            <div className='pc-ai-explain__text'>{change.aiExplanation}</div>
          </div>
        )}
      </div>
    );
  };

  const renderPanel = (side: 'left' | 'right') => {
    const file = side === 'left' ? oldFile : newFile;
    const version = file?.version || (side === 'left' ? doc?.oldVersion : doc?.newVersion);
    const label = side === 'left' ? '旧政策' : '新政策';
    const scrollRef = side === 'left' ? leftScrollRef : rightScrollRef;
    return (
      <div className='pc-panel'>
        <div className='pc-panel__head'>
          <span className='pc-panel__label'>{label}</span>
          <span className='pc-panel__version'>{version}</span>
        </div>
        <div className='pc-panel__scroll' ref={scrollRef}>
          {changes.map((change, i) => renderChangeBlock(change, side, i))}
        </div>
      </div>
    );
  };

  return (
    <div className='pc-page'>
      <header className='pc-header'>
        <div className='pc-header__left'>
          <button type='button' className='pc-back' onClick={onBack}>
            ← 返回
          </button>
          <div className='pc-header__titles'>
            <h1 className='pc-header__title'>政策变更对照</h1>
            {doc && (
              <div className='pc-header__doc'>
                <span className='pc-header__doc-name'>《{doc.name}》</span>
                <span className='pc-header__doc-versions'>
                  <span className='pc-ver pc-ver--old'>{doc.oldVersion}</span>
                  <span className='pc-ver__arrow'>→</span>
                  <span className='pc-ver pc-ver--new'>{doc.newVersion}</span>
                </span>
              </div>
            )}
          </div>
        </div>
        <button type='button' className='pc-back pc-home-btn' onClick={onHome} title='返回首页'>
          <Home size={15} theme='outline' fill='currentColor' />
        </button>
      </header>

      {summary && (
        <div className='pc-summary'>
          <span className='pc-summary__total'>
            共发现 <strong>{summary.total}</strong> 处变化
          </span>
          <div className='pc-summary__tags'>
            <span className='pc-tag pc-tag--modified'>{summary.modified} 项修改</span>
            <span className='pc-tag pc-tag--added'>{summary.added} 项新增</span>
            <span className='pc-tag pc-tag--removed'>{summary.removed} 项删除</span>
          </div>
        </div>
      )}

      {changes.length > 0 && (
        <div className='pc-nav'>
          <button type='button' className='pc-nav__btn' onClick={goPrev} disabled={activeIndex === 0}>
            ← 上一处
          </button>
          <span className='pc-nav__counter'>
            变化 <strong>{activeIndex + 1}</strong> / {changes.length}
          </span>
          <button type='button' className='pc-nav__btn' onClick={goNext} disabled={activeIndex === changes.length - 1}>
            下一处 →
          </button>
        </div>
      )}

      {changes.length > 0 ? (
        <div className='pc-diff'>
          {renderPanel('left')}
          <div className='pc-diff__divider' />
          {renderPanel('right')}
        </div>
      ) : (
        <div className='pc-state'>
          <p className='pc-state__title'>两个版本没有发现明显变化</p>
          <p className='pc-state__sub'>政策内容可能完全一致，或差异过小未被识别</p>
        </div>
      )}
    </div>
  );
};

export default PolicyDiffView;
