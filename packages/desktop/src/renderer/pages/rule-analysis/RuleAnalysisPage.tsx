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
import type { CampusRuleToolResult } from '@renderer/components/campus-rule/types';
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

  // ---- 调试：JSON 注入弹窗 ----
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugJson, setDebugJson] = useState('');
  const [debugError, setDebugError] = useState<string | null>(null);
  const [debugTaskName, setDebugTaskName] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        setDebugOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleDebugInject = () => {
    try {
      const parsed = JSON.parse(debugJson) as CampusRuleToolResult;
      if (!parsed || typeof parsed !== 'object') throw new Error('JSON 必须是对象');
      const targetName = debugTaskName.trim() || '调试分析';
      const targetTaskId = api.createTask(targetName);
      api.debugInjectResult(targetTaskId, parsed, '调试注入');
      api.openInterpret(targetTaskId);
      setDebugOpen(false);
      setDebugJson('');
      setDebugTaskName('');
      setDebugError(null);
    } catch (err) {
      setDebugError(err instanceof Error ? err.message : 'JSON 解析失败');
    }
  };

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    []
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
    [api]
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
        onDebug={() => setDebugOpen(true)}
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

      {/* 调试注入弹窗 */}
      {debugOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
          }}
          onClick={() => setDebugOpen(false)}
        >
          <div
            style={{
              background: '#fff',
              borderRadius: '16px',
              padding: '24px',
              width: '560px',
              maxWidth: '90vw',
              maxHeight: '80vh',
              overflow: 'auto',
              boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>调试注入 MCP 结果</div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>任务名称（留空则自动命名）</div>
              <input
                type='text'
                value={debugTaskName}
                onChange={(e) => setDebugTaskName(e.target.value)}
                placeholder='例如：三好学生资格分析'
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  borderRadius: '8px',
                  border: '1px solid #e0e0e0',
                  fontSize: 13,
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>MCP 返回 JSON</div>
              <textarea
                value={debugJson}
                onChange={(e) => setDebugJson(e.target.value)}
                placeholder='粘贴完整的 CampusRuleToolResult JSON...'
                style={{
                  width: '100%',
                  height: '280px',
                  padding: '12px',
                  borderRadius: '8px',
                  border: '1px solid #e0e0e0',
                  fontSize: 12,
                  fontFamily: 'Consolas, Monaco, monospace',
                  resize: 'vertical',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            {debugError && <div style={{ color: '#d4380d', fontSize: 12, marginBottom: 12 }}>{debugError}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                type='button'
                onClick={() => setDebugOpen(false)}
                style={{
                  padding: '6px 16px',
                  borderRadius: '8px',
                  border: '1px solid #e0e0e0',
                  background: '#fff',
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                取消
              </button>
              <button
                type='button'
                onClick={handleDebugInject}
                disabled={!debugJson.trim()}
                style={{
                  padding: '6px 16px',
                  borderRadius: '8px',
                  border: 'none',
                  background: 'linear-gradient(135deg, #7f9d78, #648b80)',
                  color: '#fff',
                  fontSize: 13,
                  cursor: debugJson.trim() ? 'pointer' : 'not-allowed',
                  opacity: debugJson.trim() ? 1 : 0.5,
                }}
              >
                注入并渲染
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default RuleAnalysisPage;
