import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorkbench } from './store';
import type { ReportSnapshot, ViewName } from './model';
import TopNav from './components/TopNav';
import PolicyEntryView from './components/PolicyEntryView';
import { InterpretView } from './views/InterpretView';
import ReportsView from './views/ReportsView';
import ReportDetailView from './views/ReportDetailView';
import ProfileView from './views/ProfileView';
import './workbench.css';

/**
 * 政策解读工作台（原 /rule-analysis 占位页的整体产品化重构）
 *
 * 核心产品原则：
 *   分析永不结束 —— AnalysisTask 永久存在，无「已完成」状态；
 *   报告永远是快照 —— ReportSnapshot 不可变，V1→V2→V3 只增不改。
 *
 * 页面状态：
 *   entry    —— 政策解读首页（提问入口，真实 AI 对话）
 *   analysis —— 政策解读视图（AI 调用政策 MCP 后的结构化解读结果 + 追问）
 *   reports / report / profile —— 我的报告 / 报告详情 / 我的信息
 */
const RuleAnalysisPage: React.FC = () => {
  const navigate = useNavigate();
  const api = useWorkbench();
  const { ui, state } = api;

  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  /* 顶栏「政策解读」：无条件回到提问入口（空状态），不保留任何「已在工作台则不动」的分支。
     从「我的报告」/报告详情/我的信息/分析工作台任何位置点它，看到的都是政策解读首页；
     需要继续分析时点「最近分析」恢复原任务（activeTaskId 保留）。 */
  const handleTab = useCallback(
    (v: ViewName) => {
      if (v === 'analysis') {
        api.switchView('entry');
        return;
      }
      api.switchView(v);
    },
    [api],
  );

  const viewingReport: ReportSnapshot | undefined = ui.viewingReportId
    ? state.reports.find((r) => r.id === ui.viewingReportId)
    : undefined;

  return (
    <div className='ra-page'>
      <TopNav
        view={ui.view}
        onTab={handleTab}
        onHome={() => navigate('/home')}
        onReset={() => {
          api.resetDemo();
          notify('演示数据已重置');
        }}
      />

      {ui.view === 'entry' && <PolicyEntryView api={api} notify={notify} />}
      {ui.view === 'analysis' && <InterpretView api={api} />}
      {ui.view === 'reports' && (
        <div className='ra-scroll'>
          <ReportsView api={api} />
        </div>
      )}
      {ui.view === 'report' &&
        (viewingReport ? (
          <div className='ra-scroll'>
            <ReportDetailView api={api} report={viewingReport} notify={notify} />
          </div>
        ) : (
          <div className='ra-scroll'>
            <div className='ra-container'>
              <div className='ra-empty'>报告不存在或已被清除。</div>
            </div>
          </div>
        ))}
      {ui.view === 'profile' && (
        <div className='ra-scroll'>
          <ProfileView api={api} notify={notify} />
        </div>
      )}

      {toast && (
        <div className='ra-toast' role='status'>
          {toast}
        </div>
      )}
    </div>
  );
};

export default RuleAnalysisPage;
