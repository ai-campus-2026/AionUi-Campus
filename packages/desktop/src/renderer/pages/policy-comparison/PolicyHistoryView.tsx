import { useNavigate } from 'react-router-dom';
import { Home, Delete, Check } from '@icon-park/react';
import React, { useMemo, useState } from 'react';
import type { ComparisonHistoryRecord } from './types';

interface PolicyHistoryViewProps {
  history: ComparisonHistoryRecord[];
  onBack: () => void;
  onNewCompare: () => void;
  onSelectRecord: (record: ComparisonHistoryRecord) => void;
  onDelete: (recordId: string) => void;
  onBatchDelete: (recordIds: string[]) => void;
}

/** 格式化时间：今天 · HH:mm / 昨天 · HH:mm / MM月DD日 · HH:mm */
function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today.getTime() - target.getTime()) / 86400000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (diffDays === 0) return `今天 · ${hh}:${mm}`;
  if (diffDays === 1) return `昨天 · ${hh}:${mm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 · ${hh}:${mm}`;
}

const PolicyHistoryView: React.FC<PolicyHistoryViewProps> = ({
  history,
  onBack,
  onNewCompare,
  onSelectRecord,
  onDelete,
  onBatchDelete,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [timeFilter, setTimeFilter] = useState<'all' | '7d' | '30d'>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const navigate = useNavigate();

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((r) => r.id)));
    }
  };

  const handleDelete = (id: string) => {
    if (window.confirm('确定删除这条对照记录吗？删除后无法恢复。')) {
      onDelete(id);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleBatchDelete = () => {
    if (selected.size === 0) return;
    if (window.confirm(`确定删除选中的 ${selected.size} 条对照记录吗？删除后无法恢复。`)) {
      onBatchDelete(Array.from(selected));
      setSelected(new Set());
      setSelectMode(false);
    }
  };

  const filtered = useMemo(() => {
    const now = Date.now();
    const dayMs = 86400000;
    return history
      .filter((r) => {
        if (timeFilter === '7d' && now - new Date(r.createdAt).getTime() > 7 * dayMs) return false;
        if (timeFilter === '30d' && now - new Date(r.createdAt).getTime() > 30 * dayMs) return false;
        if (searchQuery.trim()) {
          const q = searchQuery.trim().toLowerCase();
          const haystack = [r.docName, r.oldFile, r.newFile].filter(Boolean).join(' ').toLowerCase();
          if (!haystack.includes(q)) return false;
        }
        return true;
      })
      .toSorted((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [history, searchQuery, timeFilter]);

  return (
    <div className='pc-history'>
      <header className='pc-history__header'>
        <div className='pc-history__header-left'>
          <button type='button' className='pc-back' onClick={onBack}>
            ← 返回
          </button>
          <div className='pc-history__titles'>
            <h1 className='pc-history__title'>政策对照历史</h1>
            <p className='pc-history__subtitle'>查看过去进行过的所有政策版本对照</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {selectMode ? (
            <>
              <span style={{ fontSize: 12, color: 'var(--color-text-3)' }}>已选 {selected.size} 条</span>
              <button type='button' className='pc-btn pc-btn--ghost' onClick={selectAll}>
                {selected.size === filtered.length ? '取消全选' : '全选'}
              </button>
              <button
                type='button'
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '4px 12px',
                  borderRadius: '8px',
                  border: 'none',
                  background: 'linear-gradient(135deg, #e8a598, #d48b7a)',
                  color: '#fff',
                  fontSize: 12,
                  cursor: selected.size === 0 ? 'not-allowed' : 'pointer',
                  opacity: selected.size === 0 ? 0.5 : 1,
                }}
                onClick={handleBatchDelete}
                disabled={selected.size === 0}
              >
                <Delete size={13} theme='outline' fill='currentColor' />
                批量删除
              </button>
              <button
                type='button'
                className='pc-btn pc-btn--ghost'
                onClick={() => {
                  setSelectMode(false);
                  setSelected(new Set());
                }}
              >
                退出
              </button>
            </>
          ) : (
            <>
              <button
                type='button'
                className='pc-btn pc-btn--ghost pc-home-btn'
                onClick={() => navigate('/')}
                title='返回首页'
              >
                <Home size={15} theme='outline' fill='currentColor' />
              </button>
              <button type='button' className='pc-btn pc-btn--ghost' onClick={() => setSelectMode(true)}>
                <Delete size={13} theme='outline' fill='currentColor' style={{ marginRight: 4 }} />
                管理
              </button>
              <button type='button' className='pc-btn pc-btn--primary pc-btn--large' onClick={onNewCompare}>
                ＋ 新建对比
              </button>
            </>
          )}
        </div>
      </header>

      <div className='pc-history__body'>
        <div className='pc-history__toolbar'>
          <div className='pc-history__search'>
            <span className='pc-history__search-icon'>⌕</span>
            <input
              type='text'
              className='pc-history__search-input'
              placeholder='搜索政策名称或文件名'
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button type='button' className='pc-history__search-clear' onClick={() => setSearchQuery('')}>
                ✕
              </button>
            )}
          </div>
          <div className='pc-history__filter'>
            {(['all', '7d', '30d'] as const).map((f) => (
              <button
                key={f}
                type='button'
                className={`pc-history__filter-btn ${timeFilter === f ? 'pc-history__filter-btn--active' : ''}`}
                onClick={() => setTimeFilter(f)}
              >
                {f === 'all' ? '全部' : f === '7d' ? '最近7天' : '最近30天'}
              </button>
            ))}
          </div>
        </div>

        {filtered.length > 0 ? (
          <div className='pc-history__list'>
            {filtered.map((record) => {
              const isSelected = selected.has(record.id);
              return (
                <div
                  key={record.id}
                  className='pc-history__item'
                  style={
                    isSelected
                      ? {
                          borderColor: 'var(--color-primary-light-3)',
                          boxShadow: '0 0 0 2px var(--color-primary-light-2)',
                        }
                      : undefined
                  }
                  onClick={() => {
                    if (!selectMode) onSelectRecord(record);
                  }}
                  role='button'
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !selectMode) onSelectRecord(record);
                  }}
                >
                  {selectMode && (
                    <button
                      type='button'
                      onClick={() => toggleSelect(record.id)}
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 4,
                        border: isSelected ? 'none' : '1.5px solid var(--color-border-2)',
                        background: isSelected ? '#648b80' : 'transparent',
                        color: '#fff',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        flexShrink: 0,
                      }}
                    >
                      {isSelected && <Check size={12} theme='outline' fill='currentColor' />}
                    </button>
                  )}
                  <div className='pc-history__item-time'>{formatTime(record.createdAt)}</div>
                  <div className='pc-history__item-main'>
                    <div className='pc-history__item-name'>《{record.docName}》</div>
                    <div className='pc-history__item-versions'>
                      <span className='pc-history__item-ver'>{record.oldVersion}</span>
                      <span className='pc-history__item-arrow'>→</span>
                      <span className='pc-history__item-ver pc-history__item-ver--new'>{record.newVersion}</span>
                    </div>
                  </div>
                  {record.summary && (
                    <div className='pc-history__item-summary'>
                      <div className='pc-history__item-total'>
                        <span className='pc-history__item-total-num'>{record.summary.total}</span>
                        <span className='pc-history__item-total-label'>处变化</span>
                      </div>
                      <div className='pc-history__item-breakdown'>
                        {record.summary.modified > 0 && (
                          <span className='pc-history__item-tag pc-history__item-tag--modified'>
                            修改 {record.summary.modified}
                          </span>
                        )}
                        {record.summary.added > 0 && (
                          <span className='pc-history__item-tag pc-history__item-tag--added'>
                            新增 {record.summary.added}
                          </span>
                        )}
                        {record.summary.removed > 0 && (
                          <span className='pc-history__item-tag pc-history__item-tag--removed'>
                            删除 {record.summary.removed}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  {!selectMode && (
                    <>
                      <div className='pc-history__item-action'>
                        查看对照
                        <span className='pc-history__item-arrow-icon'>→</span>
                      </div>
                      <button
                        type='button'
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(record.id);
                        }}
                        style={{
                          padding: '4px 8px',
                          borderRadius: '6px',
                          border: 'none',
                          background: 'transparent',
                          color: 'var(--color-text-3)',
                          cursor: 'pointer',
                          fontSize: 12,
                        }}
                        title='删除这条对照记录'
                      >
                        <Delete size={14} theme='outline' fill='currentColor' />
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ) : history.length === 0 ? (
          <div className='pc-history__empty'>
            <div className='pc-history__empty-icon'>📋</div>
            <div className='pc-history__empty-title'>还没有政策对照记录</div>
            <div className='pc-history__empty-desc'>完成第一次政策对比后，你的历史结果会出现在这里。</div>
            <button type='button' className='pc-btn pc-btn--primary pc-btn--large' onClick={onNewCompare}>
              开始第一次对比
            </button>
          </div>
        ) : (
          <div className='pc-history__empty'>
            <div className='pc-history__empty-icon'>🔍</div>
            <div className='pc-history__empty-title'>没有找到相关对照记录</div>
            <div className='pc-history__empty-desc'>尝试搜索其他政策名称或文件名。</div>
          </div>
        )}
      </div>
    </div>
  );
};

export default PolicyHistoryView;
