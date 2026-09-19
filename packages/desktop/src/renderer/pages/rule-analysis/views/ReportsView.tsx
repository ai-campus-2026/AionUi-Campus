import React, { useState } from 'react';
import { FileText, ArrowRight, DoubleRight, Target, Down, Up } from '@icon-park/react';
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

  const toggleCollapse = (taskId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  // 按最新报告时间排序
  const sortedTasks = [...state.tasks].sort((a, b) => {
    const aLatest = state.reports
      .filter((r) => r.analysisTaskId === a.id)
      .sort((x, y) => y.version - x.version)[0];
    const bLatest = state.reports
      .filter((r) => r.analysisTaskId === b.id)
      .sort((x, y) => y.version - x.version)[0];
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
        {/* 排序选择 */}
        <div className='ra-reports__sort'>
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
          // 优先从 state.policyVersions 查找，找不到则回退用报告自身记录的 policyVersion
          const policyFromState = findPolicy(state, task.policyVersionId);
          const policy = policyFromState ?? latest?.policyVersion ?? null;

          return (
            <div key={task.id} className='ra-card ra-rep-task'>
              <div className='ra-rep-task__head'>
                <Target size={15} theme='outline' fill='currentColor' style={{ color: 'var(--color-text-3)' }} />
                <span className='ra-rep-task__title'>{task.title}</span>
                <span className='ra-rep-task__tag'>已生成 {reports.length} 份快照</span>
                <span className='ra-rep-task__policy'>
                  {policy ? `${policy.title} ${policy.version} · ${policy.publishedAt} 发布` : ''}
                </span>
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
                    {latest.changes.find((c) => c.label === '新增信息')?.text ??
                      latest.changes[0]?.text ??
                      '—'}
                  </span>
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
                    <button type='button' className='ra-btn ra-btn--primary' onClick={() => api.openReportOfTask(task.id)}>
                      <DoubleRight size={13} theme='outline' fill='currentColor' />
                      查看报告
                    </button>
                  </span>
                </div>
              )}

              {history.length > 0 && (
                <div className='ra-rep-task__history'>
                  <button
                    type='button'
                    className='ra-rep-task__htoggle'
                    onClick={() => toggleCollapse(task.id)}
                  >
                    <span className='ra-rep-task__hlabel'>历史快照（{history.length}）</span>
                    <span className='ra-rep-task__hicon'>
                      {isCollapsed ? <Down size={12} theme='outline' fill='currentColor' /> : <Up size={12} theme='outline' fill='currentColor' />}
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
