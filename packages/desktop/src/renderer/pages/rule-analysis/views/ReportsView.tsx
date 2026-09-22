import React, { useState } from 'react';
import { FileText, ArrowRight, DoubleRight, Target, Down, Up, Delete, Check } from '@icon-park/react';
import type { WorkbenchApi } from '../store';
import { findPolicy } from '../engine';
import type { ReportSnapshot } from '../model';

function summaryText(r: ReportSnapshot): string {
  return `✓ ${r.summary.met} 项满足 · ! ${r.summary.missing} 项待确认 · × ${r.summary.notMet} 项未满足`;
}

/** 我的报告：分析任务 + 最新快照 + 历史版本（不是 PDF 文件列表） */
const ReportsView: React.FC<{ api: WorkbenchApi }> = ({ api }) => {
  const { state } = api;
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);

  const toggleCollapse = (taskId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const toggleSelect = (taskId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === sortedTasks.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(sortedTasks.map((t) => t.id)));
    }
  };

  const handleDelete = (taskId: string) => {
    if (window.confirm('确定删除这条分析记录吗？该操作会同时删除其所有报告快照，不可恢复。')) {
      api.deleteTask(taskId);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  };

  const handleBatchDelete = () => {
    if (selected.size === 0) return;
    if (window.confirm(`确定删除选中的 ${selected.size} 条分析记录吗？该操作不可恢复。`)) {
      api.deleteTasks(Array.from(selected));
      setSelected(new Set());
      setSelectMode(false);
    }
  };

  // 按最新报告时间排序
  const sortedTasks = [...state.tasks].sort((a, b) => {
    const aLatest = state.reports.filter((r) => r.analysisTaskId === a.id).sort((x, y) => y.version - x.version)[0];
    const bLatest = state.reports.filter((r) => r.analysisTaskId === b.id).sort((x, y) => y.version - x.version)[0];
    const aTime = aLatest?.createdAt ?? a.updatedAt;
    const bTime = bLatest?.createdAt ?? b.updatedAt;
    if (sortOrder === 'desc') return aTime < bTime ? 1 : -1;
    return aTime < bTime ? -1 : 1;
  });

  if (state.tasks.length === 0) {
    return (
      <div className='ra-container'>
        <div className='ra-empty'>还没有分析任务。先到「政策解读」创建一个目标吧。</div>
      </div>
    );
  }

  return (
    <div className='ra-container'>
      <div className='ra-head'>
        <div>
          <div className='ra-head__title'>
            <span className='ra-head__title-icon'>
              <FileText size={17} theme='outline' fill='currentColor' />
            </span>
            我的报告
          </div>
          <div className='ra-head__sub'>每次重新分析都会生成新的报告快照 · 旧版本永远保留、不可修改</div>
        </div>
        {/* 排序 + 批量操作 */}
        <div className='ra-reports__sort' style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {selectMode ? (
            <>
              <span style={{ fontSize: 12, color: 'var(--color-text-3)' }}>已选 {selected.size} 条</span>
              <button type='button' className='ra-reports__sort-btn' onClick={selectAll}>
                {selected.size === sortedTasks.length ? '取消全选' : '全选'}
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
                className='ra-reports__sort-btn'
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
              <span className='ra-reports__sort-label'>排序</span>
              <button
                type='button'
                className={`ra-reports__sort-btn ${sortOrder === 'desc' ? 'active' : ''}`}
                onClick={() => setSortOrder('desc')}
              >
                最新优先
              </button>
              <button
                type='button'
                className={`ra-reports__sort-btn ${sortOrder === 'asc' ? 'active' : ''}`}
                onClick={() => setSortOrder('asc')}
              >
                最早优先
              </button>
              <button type='button' className='ra-reports__sort-btn' onClick={() => setSelectMode(true)}>
                <Delete size={13} theme='outline' fill='currentColor' style={{ marginRight: 4 }} />
                管理
              </button>
            </>
          )}
        </div>
      </div>

      <div className='ra-reports'>
        {sortedTasks.map((task) => {
          const reports = state.reports
            .filter((r) => r.analysisTaskId === task.id)
            .sort((a, b) => b.version - a.version);
          const latest = reports[0];
          const history = reports.slice(1);
          const isCollapsed = collapsed.has(task.id);
          const isSelected = selected.has(task.id);
          const policyFromState = findPolicy(state, task.policyVersionId);
          const policy = policyFromState ?? latest?.policyVersion ?? null;

          return (
            <div
              key={task.id}
              className='ra-card ra-rep-task'
              style={
                isSelected
                  ? { borderColor: 'var(--color-primary-light-3)', boxShadow: '0 0 0 2px var(--color-primary-light-2)' }
                  : undefined
              }
            >
              <div className='ra-rep-task__head'>
                {selectMode && (
                  <button
                    type='button'
                    onClick={() => toggleSelect(task.id)}
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
                <Target size={15} theme='outline' fill='currentColor' style={{ color: 'var(--color-text-3)' }} />
                <span className='ra-rep-task__title'>{task.title}</span>
                <span className='ra-rep-task__tag'>已生成 {reports.length} 份快照</span>
                <span className='ra-rep-task__policy'>
                  {policy ? `${policy.title} ${policy.version} · ${policy.publishedAt} 发布` : ''}
                </span>
                {!selectMode && (
                  <button
                    type='button'
                    onClick={() => handleDelete(task.id)}
                    style={{
                      marginLeft: 'auto',
                      padding: '4px 8px',
                      borderRadius: '6px',
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--color-text-3)',
                      cursor: 'pointer',
                      fontSize: 12,
                    }}
                    title='删除此分析记录'
                  >
                    <Delete size={14} theme='outline' fill='currentColor' />
                  </button>
                )}
              </div>

              {latest && (
                <div className='ra-rep-task__latest'>
                  <span className='ra-rep-task__v'>
                    <span className='ra-rep-task__vnum'>V{latest.version}</span>
                    {latest.createdAt}
                  </span>
                  <span className='ra-rep-task__change'>{summaryText(latest)}</span>
                  <span className='ra-rep-task__change'>
                    最近变化：
                    {latest.changes.find((c) => c.label === '新增信息')?.text ?? latest.changes[0]?.text ?? '—'}
                  </span>
                  {!selectMode && (
                    <span className='ra-rep-task__actions'>
                      <button
                        type='button'
                        className='ra-btn'
                        onClick={() => {
                          api.openInterpret(task.id);
                        }}
                      >
                        <ArrowRight size={13} theme='outline' fill='currentColor' />
                        继续完善
                      </button>
                      <button
                        type='button'
                        className='ra-btn ra-btn--primary'
                        onClick={() => api.openReportOfTask(task.id)}
                      >
                        <DoubleRight size={13} theme='outline' fill='currentColor' />
                        查看报告
                      </button>
                    </span>
                  )}
                </div>
              )}

              {history.length > 0 && !selectMode && (
                <div className='ra-rep-task__history'>
                  <button type='button' className='ra-rep-task__htoggle' onClick={() => toggleCollapse(task.id)}>
                    <span className='ra-rep-task__hlabel'>历史快照（{history.length}）</span>
                    <span className='ra-rep-task__hicon'>
                      {isCollapsed ? (
                        <Down size={12} theme='outline' fill='currentColor' />
                      ) : (
                        <Up size={12} theme='outline' fill='currentColor' />
                      )}
                    </span>
                  </button>
                  {!isCollapsed && (
                    <div className='ra-rep-task__hlist'>
                      {history.map((r) => (
                        <button key={r.id} type='button' className='ra-rep-hist' onClick={() => api.viewReport(r.id)}>
                          V{r.version} · {r.createdAt}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ReportsView;
