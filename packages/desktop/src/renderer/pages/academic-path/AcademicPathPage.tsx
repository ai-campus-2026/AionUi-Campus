import React, { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { PathView, ProgramPlan, StudentProgress, CourseStatus, CourseCategory } from './types';
import { parseProgramPlan, adaptMcpPlan } from './programParser';
import { clearCourseStatuses, loadCourseStatuses, saveCourseStatuses } from './progressClient';
import EmptyState from './components/EmptyState';
import ConfirmPlan from './components/ConfirmPlan';
import PathWorkbench from './components/PathWorkbench';
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

const AcademicPathPage: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [view, setView] = useState<PathView>('empty');
  const [plan, setPlan] = useState<ProgramPlan | null>(() => loadPlan());
  const [progress, setProgress] = useState<StudentProgress>(() => loadProgress() ?? { planId: '', courseStatuses: {} });
  const [history, setHistory] = useState<ProgramPlan[]>(() => loadHistory());
  const [pendingPlan, setPendingPlan] = useState<ProgramPlan | null>(null);
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);
  const [parseSource, setParseSource] = useState<'mock' | 'mcp'>('mock');
  const [parseError, setParseError] = useState<{ code: string; message: string } | null>(null);
  const [returnView, setReturnView] = useState<'empty' | 'history'>('empty');
  const [isParsing, setIsParsing] = useState(false);

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
        setPendingPlan(result.plan);
        setParseWarnings(result.warnings ?? []);
        setParseSource('mcp');
        setView('confirm');
      } catch {
        setParseError({ code: 'UNKNOWN', message: t('mcp.curriculumImportFailed') });
      } finally {
        setIsParsing(false);
      }
    },
    [isParsing, t]
  );

  // ---- 调试注入：直接传入 MCP 格式 JSON，跳过真实调用，进入确认页 ----
  const handleDebugInject = useCallback((json: object) => {
    try {
      // 复用 programParser 的适配逻辑
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

  // ---- 确认培养方案 → 设为当前，进入学业路径 ----
  const handleConfirmPlan = useCallback(
    (confirmed: ProgramPlan) => {
      const current: ProgramPlan = { ...confirmed, isCurrent: true, confirmedAt: new Date().toISOString() };
      setPlan(current);
      // 旧方案降级为非当前
      const updatedHistory = history.map((p) => (p.id === current.id ? current : { ...p, isCurrent: false }));
      const newHistory = updatedHistory.some((p) => p.id === current.id)
        ? updatedHistory
        : [current, ...updatedHistory];
      setHistory(newHistory);
      // 为新方案初始化学生进度
      const newProgress: StudentProgress = {
        planId: current.id,
        courseStatuses: {},
      };
      current.courses.forEach((c) => {
        newProgress.courseStatuses[c.id] = 'not_taken';
      });
      setProgress(newProgress);
      try {
        localStorage.setItem(PLAN_KEY, JSON.stringify(current));
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(newProgress));
        localStorage.setItem(HISTORY_KEY, JSON.stringify(newHistory));
      } catch {
        /* ignore */
      }
      loadCourseStatuses(current.id)
        .then((stored) => {
          if (!stored) return;
          const restored: StudentProgress = {
            planId: current.id,
            courseStatuses: { ...newProgress.courseStatuses, ...stored },
            lastSyncedAt: new Date().toISOString(),
          };
          setProgress((previous) => (previous.planId === current.id ? restored : previous));
          try {
            localStorage.setItem(PROGRESS_KEY, JSON.stringify(restored));
          } catch {
            /* ignore */
          }
        })
        .catch(() => {
          /* keep unsynced in-memory state */
        });
      setPendingPlan(null);
      setReturnView('empty');
      setView('workbench');
    },
    [history]
  );

  // ---- 更新课程状态（临时，待同步） ----
  const handleCourseStatusChange = useCallback((courseId: string, status: CourseStatus) => {
    setProgress((prev) => ({
      ...prev,
      courseStatuses: { ...prev.courseStatuses, [courseId]: status },
    }));
  }, []);

  // ---- 编辑课程基本信息（名称/学分/类别/学期） ----
  const handleCourseEdit = useCallback(
    (
      courseId: string,
      updates: Partial<{
        name: string;
        credits: number;
        category: CourseCategory;
        categoryLabel: string;
        semester: number;
      }>
    ) => {
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
      // 同步更新 history 中的对应方案
      setHistory((prev) =>
        prev.map((p) => {
          if (!plan || p.id !== plan.id) return p;
          return { ...p, courses: p.courses.map((c) => (c.id === courseId ? { ...c, ...updates } : c)) };
        })
      );
    },
    [plan]
  );

  // ---- 同步学业状态 ----
  const handleSync = useCallback(async (): Promise<boolean> => {
    try {
      const saved = await saveCourseStatuses(progress.planId, progress.courseStatuses);
      if (!saved) return false;
      setProgress((previous) => {
        if (previous.planId !== progress.planId) return previous;
        const next = { ...previous, lastSyncedAt: new Date().toISOString() };
        try {
          localStorage.setItem(PROGRESS_KEY, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
      return true;
    } catch {
      return false;
    }
  }, [progress]);

  const handleClearProgress = useCallback(async (): Promise<boolean> => {
    if (!plan || progress.planId !== plan.id) return false;
    try {
      if (!(await clearCourseStatuses(plan.id))) return false;
      const cleared: StudentProgress = {
        planId: plan.id,
        courseStatuses: Object.fromEntries(plan.courses.map((course) => [course.id, 'not_taken'])),
      };
      setProgress(cleared);
      try {
        localStorage.removeItem(PROGRESS_KEY);
      } catch {
        /* ignore */
      }
      return true;
    } catch {
      return false;
    }
  }, [plan, progress.planId]);

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
      setHistory(updated);
      setPlan({ ...target, isCurrent: true });
      // A different plan must not inherit another plan's student progress.
      const newProgress: StudentProgress = {
        planId: target.id,
        courseStatuses: Object.fromEntries(target.courses.map((course) => [course.id, 'not_taken'])),
        lastSyncedAt: undefined,
      };
      setProgress(newProgress);
      loadCourseStatuses(target.id)
        .then((stored) => {
          if (!stored) return;
          const restored: StudentProgress = {
            planId: target.id,
            courseStatuses: { ...newProgress.courseStatuses, ...stored },
            lastSyncedAt: new Date().toISOString(),
          };
          setProgress((previous) => (previous.planId === target.id ? restored : previous));
          try {
            localStorage.setItem(PROGRESS_KEY, JSON.stringify(restored));
          } catch {
            /* ignore */
          }
        })
        .catch(() => {
          /* retain unsynced defaults */
        });
      try {
        localStorage.setItem(PLAN_KEY, JSON.stringify({ ...target, isCurrent: true }));
        localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
      } catch {
        /* ignore */
      }
      setReturnView('history');
      setView('workbench');
    },
    [history]
  );

  if (view === 'empty') {
    return (
      <EmptyState
        onUpload={handleUpload}
        onDebugInject={handleDebugInject}
        parseError={parseError}
        hasHistory={history.length > 0}
        onViewHistory={handleViewHistory}
        onBack={() => navigate(-1)}
      />
    );
  }

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

  if (view === 'history') {
    return (
      <PlanHistory
        history={history}
        currentPlanId={plan?.id}
        onBack={() => setView('empty')}
        onSwitch={handleSwitchPlan}
        onReupload={handleReupload}
      />
    );
  }

  // workbench
  if (plan) {
    return (
      <PathWorkbench
        plan={plan}
        progress={progress}
        onCourseStatusChange={handleCourseStatusChange}
        onSync={handleSync}
        onClearProgress={handleClearProgress}
        onViewHistory={handleViewHistory}
        onReupload={handleReupload}
        onBack={() => setView(returnView)}
        onCourseEdit={handleCourseEdit}
      />
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
    />
  );
};

export default AcademicPathPage;
