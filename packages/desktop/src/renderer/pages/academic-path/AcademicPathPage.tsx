import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { PathView, ProgramPlan, StudentProgress, CourseStatus, CourseCategory } from './types';
import { parseProgramPlan, adaptMcpPlan, loadProgramGraph } from './programParser';
import { loadCourseStatuses, saveCourseStatuses } from './progressClient';
import EmptyState from './components/EmptyState';
import MyInfo from './components/MyInfo';
import ConfirmPlan from './components/ConfirmPlan';
import PathWorkbench from './components/PathWorkbench';
import FloatingAIAssistant from './components/FloatingAIAssistant';
import PlanHistory from './components/PlanHistory';
import './academic-path.css';

const PLAN_KEY = 'academic-path:current-plan';
const PROGRESS_KEY = 'academic-path:progress';
const HISTORY_KEY = 'academic-path:history';

function loadPlan(): ProgramPlan | null {
  try {
    const raw = localStorage.getItem(PLAN_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return null;
}

function loadProgress(): StudentProgress | null {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return null;
}

function loadHistory(): ProgramPlan[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return [];
}

function createEmptyProgress(plan: ProgramPlan | null): StudentProgress {
  return {
    planId: plan?.id ?? '',
    courseStatuses: Object.fromEntries(plan?.courses.map((course) => [course.id, 'not_taken' as const]) ?? []),
  };
}

const AcademicPathPage: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [view, setView] = useState<PathView>('empty');
  const [plan, setPlan] = useState<ProgramPlan | null>(() => loadPlan());
  const [progress, setProgress] = useState<StudentProgress>(() => {
    const existing = loadProgress();
    return existing && existing.planId === plan?.id ? existing : createEmptyProgress(plan);
  });
  const [history, setHistory] = useState<ProgramPlan[]>(() => loadHistory());
  const [pendingPlan, setPendingPlan] = useState<ProgramPlan | null>(null);
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);
  const [parseSource, setParseSource] = useState<'mock' | 'mcp'>('mcp');
  const [parseError, setParseError] = useState<{ code: string; message: string } | null>(null);
  const [returnView, setReturnView] = useState<'empty' | 'history'>('empty');
  const [isParsing, setIsParsing] = useState(false);
  const [tempViewPlan, setTempViewPlan] = useState<ProgramPlan | null>(null);

  // ---- 顶部导航栏 ----
  const TopNav = ({ active }: { active: 'workbench' | 'profile' | 'history' | 'empty' }) => (
    <header className='ap-topnav'>
      <button type='button' className='ap-topnav__brand' onClick={() => navigate(-1)}>
        <svg
          width='16'
          height='16'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
          style={{ marginRight: '8px' }}
        >
          <path d='m15 18-6-6 6-6' />
        </svg>
        返回
      </button>
      <nav className='ap-topnav__tabs'>
        <button
          type='button'
          className={`ap-topnav__tab ${active === 'empty' ? 'ap-topnav__tab--active' : ''}`}
          onClick={() => setView('empty')}
        >
          <svg
            width='14'
            height='14'
            viewBox='0 0 24 24'
            fill='none'
            stroke='currentColor'
            strokeWidth='2'
            strokeLinecap='round'
            strokeLinejoin='round'
            style={{ marginRight: '6px' }}
          >
            <path d='M12 5v14M5 12h14' />
          </svg>
          新建路径
        </button>
        <button
          type='button'
          className={`ap-topnav__tab ${active === 'workbench' ? 'ap-topnav__tab--active' : ''}`}
          onClick={() => setView('workbench')}
        >
          <svg
            width='14'
            height='14'
            viewBox='0 0 24 24'
            fill='none'
            stroke='currentColor'
            strokeWidth='2'
            strokeLinecap='round'
            strokeLinejoin='round'
            style={{ marginRight: '6px' }}
          >
            <path d='M3 3v18h18' />
            <path d='m19 9-5 5-4-4-3 3' />
          </svg>
          我的学业路径
        </button>
        <button
          type='button'
          className={`ap-topnav__tab ${active === 'profile' ? 'ap-topnav__tab--active' : ''}`}
          onClick={() => setView('profile')}
        >
          <svg
            width='14'
            height='14'
            viewBox='0 0 24 24'
            fill='none'
            stroke='currentColor'
            strokeWidth='2'
            strokeLinecap='round'
            strokeLinejoin='round'
            style={{ marginRight: '6px' }}
          >
            <path d='M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2' />
            <circle cx='12' cy='7' r='4' />
          </svg>
          我的信息
        </button>
        <button
          type='button'
          className={`ap-topnav__tab ${active === 'history' ? 'ap-topnav__tab--active' : ''}`}
          onClick={() => setView('history')}
        >
          <svg
            width='14'
            height='14'
            viewBox='0 0 24 24'
            fill='none'
            stroke='currentColor'
            strokeWidth='2'
            strokeLinecap='round'
            strokeLinejoin='round'
            style={{ marginRight: '6px' }}
          >
            <circle cx='12' cy='12' r='10' />
            <polyline points='12 6 12 12 16 14' />
          </svg>
          培养方案历史
        </button>
      </nav>
      <button type='button' className='ap-topnav__home' onClick={() => navigate('/')}>
        <svg
          width='16'
          height='16'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
        >
          <path d='m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' />
          <polyline points='9 22 9 12 15 12 15 22' />
        </svg>
      </button>
    </header>
  );

  // ---- 上传培养方案 → 后台调用 MCP 解析，UI 内联显示解析动画 ----
  const handleUpload = useCallback(
    async (attachmentPath: string) => {
      if (isParsing) return;
      setParseError(null);
      setIsParsing(true);
      try {
        const result = await parseProgramPlan(attachmentPath);
        if (result.type === 'failed') {
          setParseError({ code: result.errorCode, message: t('mcp.curriculumImportFailed') });
          return;
        }
        if (result.plan) {
          const graphResult = await loadProgramGraph(result.plan.id);
          if (graphResult.type === 'ready') {
            setPendingPlan({
              ...graphResult.plan,
              recommendedSequences: result.plan.recommendedSequences,
            });
            setParseWarnings([...new Set([...(result.warnings ?? []), ...(graphResult.warnings ?? [])])]);
          } else {
            setPendingPlan(result.plan);
            setParseWarnings([
              ...new Set([
                ...(result.warnings ?? []),
                `${t('mcp.curriculumGraphUnavailable')} (${graphResult.errorCode})`,
              ]),
            ]);
          }
          setParseSource('mcp');
          setParseError(null);
          setView('confirm');
        }
      } catch {
        setParseError({ code: 'UNKNOWN', message: t('mcp.curriculumImportFailed') });
      } finally {
        setIsParsing(false);
      }
    },
    [isParsing, t]
  );

  // ---- 调试注入 ----
  const handleDebugInject = useCallback((json: object) => {
    try {
      const injectedPlan = adaptMcpPlan(json as import('./programParser').McpProgramPlanResult, '调试注入.json');
      setPendingPlan(injectedPlan);
      setParseWarnings(['⚠ 调试注入数据（非真实 MCP 解析结果）']);
      setParseSource('mcp');
      setParseError(null);
      setIsParsing(false);
      setView('confirm');
    } catch (err) {
      console.error('[debugInject] 适配失败:', err);
    }
  }, []);

  // ---- 确认培养方案 ----
  const handleConfirmPlan = useCallback(
    (confirmed: ProgramPlan) => {
      const current: ProgramPlan = { ...confirmed, isCurrent: true, confirmedAt: new Date().toISOString() };
      setPlan(current);
      const updatedHistory = history.map((p) => (p.id === current.id ? current : { ...p, isCurrent: false }));
      const newHistory = updatedHistory.some((p) => p.id === current.id)
        ? updatedHistory
        : [current, ...updatedHistory];
      setHistory(newHistory);
      const newProgress = createEmptyProgress(current);
      setProgress(newProgress);
      try {
        localStorage.setItem(PLAN_KEY, JSON.stringify(current));
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(newProgress));
        localStorage.setItem(HISTORY_KEY, JSON.stringify(newHistory));
      } catch {
        /* ignore */
      }
      setPendingPlan(null);
      setReturnView('empty');
      setView('workbench');
      void loadCourseStatuses(current.id)
        .then((savedStatuses) => {
          if (!savedStatuses) return;
          setProgress((previous) => {
            if (previous.planId !== current.id) return previous;
            const restored = { ...previous, courseStatuses: { ...previous.courseStatuses, ...savedStatuses } };
            try {
              localStorage.setItem(PROGRESS_KEY, JSON.stringify(restored));
            } catch {
              /* ignore */
            }
            return restored;
          });
        })
        .catch((): void => {});
    },
    [history]
  );

  // ---- 删除培养方案 ----
  const handleDeletePlan = useCallback(
    (planId: string) => {
      if (!window.confirm('确定要删除这个培养方案吗？删除后无法恢复。')) return;
      const updated = history.filter((p) => p.id !== planId);
      setHistory(updated);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
      } catch {
        /* ignore */
      }
    },
    [history]
  );

  const handleBatchDeletePlans = useCallback(
    (planIds: string[]) => {
      const idSet = new Set(planIds);
      const updated = history.filter((p) => !idSet.has(p.id));
      setHistory(updated);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
      } catch {
        /* ignore */
      }
    },
    [history]
  );

  // ---- 更新课程状态 ----
  const handleCourseStatusChange = useCallback((courseId: string, status: CourseStatus) => {
    setProgress((prev) => {
      const updated = {
        ...prev,
        courseStatuses: { ...prev.courseStatuses, [courseId]: status },
      };
      try {
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(updated));
      } catch {
        /* ignore */
      }
      return updated;
    });
  }, []);

  // ---- 编辑课程基本信息 ----
  const handleCourseEdit = useCallback(
    (
      courseId: string,
      updates: Partial<{
        name: string;
        credits: number;
        category: CourseCategory;
        categoryLabel: string;
        semester: number;
        gpa?: number;
      }>
    ) => {
      // 如果正在查看历史方案，且不是当前使用的方案，才更新历史方案
      if (tempViewPlan && (!plan || tempViewPlan.id !== plan.id)) {
        setTempViewPlan((prev) => {
          if (!prev) return prev;
          const newCourses = prev.courses.map((c) => (c.id === courseId ? { ...c, ...updates } : c));
          return { ...prev, courses: newCourses };
        });
        // 同时更新 history 里的对应方案
        setHistory((prev) =>
          prev.map((p) => {
            if (p.id !== tempViewPlan.id) return p;
            return { ...p, courses: p.courses.map((c) => (c.id === courseId ? { ...c, ...updates } : c)) };
          })
        );
        return;
      }
      // 否则更新当前方案
      setPlan((prev) => {
        if (!prev) return prev;
        const newCourses = prev.courses.map((c) => (c.id === courseId ? { ...c, ...updates } : c));
        const updated = { ...prev, courses: newCourses };
        try {
          localStorage.setItem(PLAN_KEY, JSON.stringify(updated));
        } catch {
          /* ignore */
        }
        return updated;
      });
      setHistory((prev) =>
        prev.map((p) => {
          if (!plan || p.id !== plan.id) return p;
          return { ...p, courses: p.courses.map((c) => (c.id === courseId ? { ...c, ...updates } : c)) };
        })
      );
    },
    [plan, tempViewPlan]
  );

  // ---- 同步学业状态 ----
  const handleSync = useCallback(async (): Promise<boolean> => {
    if (!plan || progress.planId !== plan.id) return false;
    try {
      const saved = await saveCourseStatuses(plan.id, progress.courseStatuses);
      if (!saved) return false;
      const updated = { ...progress, lastSyncedAt: new Date().toISOString() };
      setProgress(updated);
      try {
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(updated));
      } catch {
        /* ignore */
      }
      return true;
    } catch {
      return false;
    }
  }, [plan, progress]);

  // ---- 重新上传 ----
  const handleReupload = useCallback(() => {
    setView('empty');
  }, []);

  // ---- 查看历史方案 ----
  const handleViewHistory = useCallback(() => {
    setView('history');
  }, []);

  // ---- 从历史切换方案 ----
  const handleSwitchPlan = useCallback(
    (target: ProgramPlan) => {
      const updated = history.map((p) => ({ ...p, isCurrent: p.id === target.id }));
      const current = { ...target, isCurrent: true };
      const newProgress = createEmptyProgress(current);
      setHistory(updated);
      setPlan(current);
      setProgress(newProgress);
      try {
        localStorage.setItem(PLAN_KEY, JSON.stringify(current));
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(newProgress));
        localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
      } catch {
        /* ignore */
      }
      void loadCourseStatuses(current.id)
        .then((savedStatuses) => {
          if (!savedStatuses) return;
          setProgress((previous) => {
            if (previous.planId !== current.id) return previous;
            const restored = { ...previous, courseStatuses: { ...previous.courseStatuses, ...savedStatuses } };
            try {
              localStorage.setItem(PROGRESS_KEY, JSON.stringify(restored));
            } catch {
              /* ignore */
            }
            return restored;
          });
        })
        .catch((): void => {});
      setReturnView('history');
      setTempViewPlan(null);
      setView('workbench');
    },
    [history]
  );

  // ---- 仅查看历史方案 ----
  const handleViewPlan = useCallback((target: ProgramPlan) => {
    setTempViewPlan(target);
    setReturnView('history');
    setView('workbench');
  }, []);

  // ---- 空状态（导入页面） ----
  if (view === 'empty') {
    return (
      <div className='ap-page'>
        <TopNav active='empty' />
        <div className='ap-scroll'>
          <EmptyState
            onUpload={handleUpload}
            onDebugInject={handleDebugInject}
            parseError={parseError}
            hasHistory={history.length > 0}
            onViewHistory={handleViewHistory}
            onBack={() => navigate(-1)}
            recentPlanName={plan?.name}
            onUseRecentPlan={() => {
              const latest = history[0] || plan;
              if (latest) {
                setTempViewPlan(latest);
                setReturnView('empty');
                setView('workbench');
              }
            }}
          />
        </div>
        {plan && <FloatingAIAssistant selectedCourse={null} plan={plan} progress={progress} />}
      </div>
    );
  }

  // ---- 确认培养方案 ----
  if (view === 'confirm' && pendingPlan) {
    return (
      <ConfirmPlan
        plan={pendingPlan}
        onConfirm={handleConfirmPlan}
        onBack={() => setView('empty')}
        warnings={parseWarnings}
        source={parseSource}
      />
    );
  }

  // ---- 培养方案历史 ----
  if (view === 'history') {
    return (
      <div className='ap-page'>
        <TopNav active='history' />
        <div className='ap-scroll'>
          <PlanHistory
            history={history}
            currentPlanId={plan?.id}
            onBack={() => setView('empty')}
            onSwitch={handleSwitchPlan}
            onView={handleViewPlan}
            onReupload={handleReupload}
            onDelete={handleDeletePlan}
            onBatchDelete={handleBatchDeletePlans}
          />
        </div>
        {plan && <FloatingAIAssistant selectedCourse={null} plan={plan} progress={progress} />}
      </div>
    );
  }

  // ---- 我的信息 ----
  if (view === 'profile') {
    return (
      <div className='ap-page'>
        <TopNav active='profile' />
        <div className='ap-scroll'>
          <MyInfo plan={plan} progress={progress} />
        </div>
        {plan && <FloatingAIAssistant selectedCourse={null} plan={plan} progress={progress} />}
      </div>
    );
  }

  // ---- 我的学业路径（workbench） ----
  const displayPlan = tempViewPlan && tempViewPlan.id !== plan?.id ? tempViewPlan : plan;
  if (displayPlan) {
    return (
      <div className='ap-page'>
        <TopNav active='workbench' />
        <div className='ap-scroll'>
          <PathWorkbench
            plan={displayPlan}
            progress={progress}
            onCourseStatusChange={handleCourseStatusChange}
            onSync={handleSync}
            onViewHistory={handleViewHistory}
            onReupload={handleReupload}
            onBack={() => {
              setTempViewPlan(null);
              setView(returnView);
            }}
            onCourseEdit={handleCourseEdit}
          />
        </div>
      </div>
    );
  }

  return (
    <EmptyState
      onUpload={handleUpload}
      onDebugInject={handleDebugInject}
      parseError={parseError}
      hasHistory={history.length > 0}
      onViewHistory={handleViewHistory}
      onBack={() => navigate(-1)}
      recentPlanName={plan?.name}
      onUseRecentPlan={() => setView('workbench')}
    />
  );
};

export default AcademicPathPage;
