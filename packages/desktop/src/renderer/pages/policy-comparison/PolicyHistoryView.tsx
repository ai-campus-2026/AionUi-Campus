import { useNavigate } from 'react-router-dom';
import { Home } from '@icon-park/react';
import React, { useMemo, useState } from 'react';
import type { ComparisonHistoryRecord } from './types';

interface PolicyHistoryViewProps {
  history: ComparisonHistoryRecord[];
  onBack: () => void;
  onNewCompare: () => void;
  onSelectRecord: (record: ComparisonHistoryRecord) => void;
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
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [timeFilter, setTimeFilter] = useState<'all' | '7d' | '30d'>('all');
  const navigate = useNavigate();

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
    <div className="pc-history">
      <header className="pc-history__header">
        <div className="pc-history__header-left">
          <button type="button" className="pc-back" onClick={onBack}>← 返回</button>
          <div className="pc-history__titles">
            <h1 className="pc-history__title">政策对照历史</h1>
            <p className="pc-history__subtitle">查看过去进行过的所有政策版本对照</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button type="button" className="pc-btn pc-btn--ghost pc-home-btn" onClick={() => navigate('/')} title="返回首页"><Home size={15} theme='outline' fill='currentColor' /></button>
          <button type="button" className="pc-btn pc-btn--primary pc-btn--large" onClick={onNewCompare}>
            ＋ 新建对比
          </button>
        </div>
      </header>

      <div className="pc-history__body">
        <div className="pc-history__toolbar">
          <div className="pc-history__search">
            <span className="pc-history__search-icon">⌕</span>
            <input
              type="text"
              className="pc-history__search-input"
              placeholder="搜索政策名称或文件名"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button type="button" className="pc-history__search-clear" onClick={() => setSearchQuery('')}>✕</button>
            )}
          </div>
          <div className="pc-history__filter">
            {(['all', '7d', '30d'] as const).map((f) => (
              <button
                key={f}
                type="button"
                className={`pc-history__filter-btn ${timeFilter === f ? 'pc-history__filter-btn--active' : ''}`}
                onClick={() => setTimeFilter(f)}
              >
                {f === 'all' ? '全部' : f === '7d' ? '最近7天' : '最近30天'}
              </button>
            ))}
          </div>
        </div>

        {filtered.length > 0 ? (
          <div className="pc-history__list">
            {filtered.map((record) => (
              <div
                key={record.id}
                className="pc-history__item"
                onClick={() => onSelectRecord(record)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') onSelectRecord(record); }}
              >
                <div className="pc-history__item-time">{formatTime(record.createdAt)}</div>
                <div className="pc-history__item-main">
                  <div className="pc-history__item-name">《{record.docName}》</div>
                  <div className="pc-history__item-versions">
                    <span className="pc-history__item-ver">{record.oldVersion}</span>
                    <span className="pc-history__item-arrow">→</span>
                    <span className="pc-history__item-ver pc-history__item-ver--new">{record.newVersion}</span>
                  </div>
                </div>
                {record.summary && (
                  <div className="pc-history__item-summary">
                    <div className="pc-history__item-total">
                      <span className="pc-history__item-total-num">{record.summary.total}</span>
                      <span className="pc-history__item-total-label">处变化</span>
                    </div>
                    <div className="pc-history__item-breakdown">
                      {record.summary.modified > 0 && (
                        <span className="pc-history__item-tag pc-history__item-tag--modified">修改 {record.summary.modified}</span>
                      )}
                      {record.summary.added > 0 && (
                        <span className="pc-history__item-tag pc-history__item-tag--added">新增 {record.summary.added}</span>
                      )}
                      {record.summary.removed > 0 && (
                        <span className="pc-history__item-tag pc-history__item-tag--removed">删除 {record.summary.removed}</span>
                      )}
                    </div>
                  </div>
                )}
                <div className="pc-history__item-action">
                  查看对照
                  <span className="pc-history__item-arrow-icon">→</span>
                </div>
              </div>
            ))}
          </div>
        ) : history.length === 0 ? (
          <div className="pc-history__empty">
            <div className="pc-history__empty-icon">📋</div>
            <div className="pc-history__empty-title">还没有政策对照记录</div>
            <div className="pc-history__empty-desc">完成第一次政策对比后，你的历史结果会出现在这里。</div>
            <button type="button" className="pc-btn pc-btn--primary pc-btn--large" onClick={onNewCompare}>
              开始第一次对比
            </button>
          </div>
        ) : (
          <div className="pc-history__empty">
            <div className="pc-history__empty-icon">🔍</div>
            <div className="pc-history__empty-title">没有找到相关对照记录</div>
            <div className="pc-history__empty-desc">尝试搜索其他政策名称或文件名。</div>
          </div>
        )}
      </div>
    </div>
  );
};

export default PolicyHistoryView;
