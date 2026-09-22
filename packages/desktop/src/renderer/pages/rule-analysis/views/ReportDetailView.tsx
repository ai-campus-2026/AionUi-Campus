import React from 'react';
import { ArrowLeft, Attention, Calendar, Refresh, Lock } from '@icon-park/react';
import type { WorkbenchApi } from '../store';
import { goalPolicyPrefix } from '../engine';
import type { ReportSnapshot } from '../model';
import SummaryBar from '../components/SummaryBar';

/** 报告详情：锁定政策版本、当时个人信息、匹配结果、本次变化 */
const ReportDetailView: React.FC<{
  api: WorkbenchApi;
  report: ReportSnapshot;
  notify: (msg: string) => void;
}> = ({ api, report, notify }) => {
  const task = api.state.tasks.find((t) => t.id === report.analysisTaskId);
  const goalDef = task ? api.goalDefs.find((g) => g.goalKey === task.goalKey) : undefined;
  const prefix = goalDef ? goalPolicyPrefix(goalDef.goalKey) : '';
  const latestPolicy =
    api.state.policyVersions.find((p) => p.latest && p.id.startsWith(prefix)) ??
    api.state.policyVersions.find((p) => p.latest);
  const stale = !!latestPolicy && latestPolicy.id !== report.policyVersion.id;

  return (
    <div className='ra-container'>
      <button type='button' className='ra-detail__back' onClick={() => api.switchView('reports')}>
        <ArrowLeft size={14} theme='outline' fill='currentColor' />
        返回我的报告
      </button>

      {/* 政策已更新提示（不改旧报告） */}
      {stale && (
        <div className='ra-detail__banner' role='alert'>
          <span className='ra-detail__banner-icon'>
            <Attention size={16} theme='outline' fill='currentColor' />
          </span>
          <span>
            ⚠ 政策已更新：当前报告基于旧版政策（{report.policyVersion.version}），最新版本为「
            {latestPolicy?.version}」。
          </span>
          <span className='ra-detail__banner-actions'>
            <button
              type='button'
              className='ra-btn ra-btn--primary'
              onClick={() => {
                api.reanalyzeWithLatestPolicy(task!.id);
                notify('已基于最新政策重新分析，生成了新的报告快照');
              }}
            >
              <Refresh size={13} theme='outline' fill='currentColor' />
              基于最新政策重新分析
            </button>
          </span>
        </div>
      )}

      {/* 元信息 */}
      <div className='ra-card ra-detail__meta'>
        <div className='ra-detail__meta-row'>
          <span className='ra-detail__meta-k'>分析任务</span>
          <span className='ra-detail__meta-v'>{task?.title ?? '—'}</span>
        </div>
        <div className='ra-detail__meta-row'>
          <span className='ra-detail__meta-k'>报告版本</span>
          <span className='ra-detail__meta-v'>
            <span className='ra-rep-task__vnum'>V{report.version}</span>
          </span>
        </div>
        <div className='ra-detail__meta-row'>
          <span className='ra-detail__meta-k'>生成时间</span>
          <span className='ra-detail__meta-v'>
            <Calendar size={13} theme='outline' fill='currentColor' style={{ verticalAlign: '-2px', marginRight: 5 }} />
            {report.createdAt}
          </span>
        </div>
        <div className='ra-detail__meta-row'>
          <span className='ra-detail__meta-k'>当时政策版本</span>
          <span className='ra-detail__meta-v'>
            {report.policyVersion.title} {report.policyVersion.version}
            <span className='ra-detail__meta-badge' style={{ marginLeft: 8 }}>
              {report.policyVersion.publishedAt} 发布
            </span>
          </span>
        </div>
      </div>

      {/* 匹配结果 */}
      <div className='ra-detail__section'>
        <div className='ra-detail__section-title'>
          <span className='ra-dot' />
          匹配结果
        </div>
        <SummaryBar summary={report.summary} />
      </div>

      {report.matchResults.map((g) => (
        <div key={g.id} className='ra-detail__section'>
          <div className='ra-detail__section-title'>
            <span className='ra-dot' />
            {g.label}
          </div>
          <div className='ra-group__cards'>
            {g.rows.map((row) => {
              const isMet = row.match === 'met';
              const isMissing = row.match === 'missing_info' || row.match === 'needs_manual_review';
              const badgeCls = isMet ? 'ra-cond__badge--met' : isMissing ? 'ra-cond__badge--missing' : 'ra-cond__badge--notmet';
              const badgeText = isMet ? '已满足' : isMissing ? '待确认' : '未满足';
              const iconCls = isMet ? 'ra-cond__icon--met' : isMissing ? 'ra-cond__icon--missing' : 'ra-cond__icon--notmet';
              return (
                <div key={row.id} className='ra-cond'>
                  <span className={`ra-cond__icon ${iconCls}`}>
                    {isMet ? '✓' : isMissing ? '!' : '×'}
                  </span>
                  <div className='ra-cond__body'>
                    <div className='ra-cond__row1'>
                      <span className='ra-cond__name'>{row.item}</span>
                      <span className={`ra-cond__badge ${badgeCls}`}>{badgeText}</span>
                    </div>
                    <div className='ra-cond__kv'>
                      <div className='ra-cond__kvitem'>
                        <div className='ra-cond__k'>当前</div>
                        <div className={`ra-cond__v${isMissing && !row.userValue ? ' ra-cond__v--empty' : ''}`}>
                          {row.userValue || '未提供'}
                        </div>
                      </div>
                      <div className='ra-cond__kvitem'>
                        <div className='ra-cond__k'>政策要求</div>
                        <div className='ra-cond__v'>{row.requirement ?? '—'}</div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* 当时个人信息快照 */}
      <div className='ra-detail__section'>
        <div className='ra-detail__section-title'>
          <span className='ra-dot' />
          当时个人信息
        </div>
        <div className='ra-card ra-detail__snapshot'>
          {report.profileSnapshot.length === 0 && <div className='ra-empty'>当时未提供个人信息</div>}
          {report.profileSnapshot.map((p) => (
            <div key={p.label} className='ra-detail__snap-item'>
              <div className='ra-detail__snap-k'>{p.label}</div>
              <div className='ra-detail__snap-v'>{p.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 本次变化 */}
      <div className='ra-detail__section'>
        <div className='ra-detail__section-title'>
          <span className='ra-dot' />
          本次变化
        </div>
        <div className='ra-card ra-detail__changes'>
          {report.changes.map((c, i) => (
            <div key={i} className='ra-detail__change'>
              <span className='ra-detail__change-k'>{c.label}</span>
              <span>{c.text}</span>
            </div>
          ))}
        </div>
      </div>

      {/* 不可变提示 */}
      <div className='ra-detail__locked'>
        <Lock size={12} theme='outline' fill='currentColor' style={{ verticalAlign: '-2px', marginRight: 5 }} />
        本报告是生成时刻的不可变快照，之后补充信息或政策更新都不会修改它；如需最新结果，请生成新的报告快照。
      </div>
    </div>
  );
};

export default ReportDetailView;
