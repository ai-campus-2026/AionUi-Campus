import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Home, Delete, Check } from '@icon-park/react';
import type { ProgramPlan } from '../types';

interface Props {
  history: ProgramPlan[];
  currentPlanId?: string;
  onBack: () => void;
  onSwitch: (plan: ProgramPlan) => void;
  onView: (plan: ProgramPlan) => void;
  onReupload: () => void;
  onDelete: (planId: string) => void;
  onBatchDelete: (planIds: string[]) => void;
}

function formatDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const PlanHistory: React.FC<Props> = ({ history, currentPlanId, onBack, onSwitch, onView, onReupload, onDelete, onBatchDelete }) => {
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === history.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(history.map((p) => p.id)));
    }
  };

  const handleDelete = (id: string) => {
    if (window.confirm('确定删除这个培养方案吗？删除后无法恢复。')) {
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
    if (window.confirm(`确定删除选中的 ${selected.size} 个培养方案吗？删除后无法恢复。`)) {
      onBatchDelete(Array.from(selected));
      setSelected(new Set());
      setSelectMode(false);
    }
  };

  return (
    <div className="ap-history">
      <header className="ap-history__header">
        <div className="ap-history__header-left">
          <div>
            <h1 className="ap-history__title">培养方案历史</h1>
            <p className="ap-history__subtitle">查看过去确认过的培养方案版本</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          {selectMode ? (
            <>
              <span style={{ fontSize: 12, color: 'var(--color-text-3)' }}>已选 {selected.size} 个</span>
              <button type="button" className="ap-btn ap-btn--ghost" onClick={selectAll}>
                {selected.size === history.length ? '取消全选' : '全选'}
              </button>
              <button
                type="button"
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
              <button type="button" className="ap-btn ap-btn--ghost" onClick={() => { setSelectMode(false); setSelected(new Set()); }}>
                退出
              </button>
            </>
          ) : (
            <>

              <button type="button" className="ap-btn ap-btn--ghost" onClick={() => setSelectMode(true)}>
                <Delete size={13} theme='outline' fill='currentColor' style={{ marginRight: 4 }} />
                管理
              </button>

            </>
          )}
        </div>
      </header>

      <div className="ap-history__scroll">
        <div className="ap-history__body">
        {history.length === 0 ? (
          <div className="ap-history__empty">
            <div className="ap-history__empty-icon">📋</div>
            <div className="ap-history__empty-title">还没有培养方案记录</div>
            <div className="ap-history__empty-desc">上传并确认培养方案后，记录会出现在这里。</div>
          </div>
        ) : (
          <div className="ap-history__list">
            {history.map((p) => {
              const isSelected = selected.has(p.id);
              return (
              <div
                key={p.id}
                className={`ap-history__item ${p.id === currentPlanId ? 'ap-history__item--current' : ''}`}
                style={isSelected ? { borderColor: 'var(--color-primary-light-3)', boxShadow: '0 0 0 2px var(--color-primary-light-2)' } : undefined}
              >
                {selectMode && (
                  <button
                    type="button"
                    onClick={() => toggleSelect(p.id)}
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
                <div className="ap-history__item-main">
                  <div className="ap-history__item-name">{p.name}</div>
                  <div className="ap-history__item-meta">
                    <span>{p.major} · {p.grade}</span>
                    <span>{p.version}</span>
                    <span>{p.courses.length}门课程 · {p.totalCredits}学分</span>
                    <span>确认于 {formatDate(p.confirmedAt)}</span>
                  </div>
                </div>
                <div className="ap-history__item-right">
                  {p.id === currentPlanId && <span className="ap-history__item-badge">● 当前使用</span>}
                  {!selectMode && p.id !== currentPlanId && (
                    <button type="button" className="ap-btn ap-btn--outline" onClick={() => onSwitch(p)}>
                      切换为此方案
                    </button>
                  )}
                  {!selectMode && (
                    <button type="button" className="ap-btn ap-btn--ghost" onClick={() => onView(p)}>查看</button>
                  )}
                  {!selectMode && (
                    <button
                      type="button"
                      onClick={() => handleDelete(p.id)}
                      style={{
                        padding: '4px 8px',
                        borderRadius: '6px',
                        border: 'none',
                        background: 'transparent',
                        color: 'var(--color-text-3)',
                        cursor: 'pointer',
                        fontSize: 12,
                      }}
                      title="删除此培养方案"
                    >
                      <Delete size={14} theme='outline' fill='currentColor' />
                    </button>
                  )}
                </div>
              </div>
              );
            })}
          </div>
        )}
        </div>
      </div>
    </div>
  );
};

export default PlanHistory;
