import { useNavigate } from 'react-router-dom';
import { Home } from '@icon-park/react';
import { Button, Message, Modal } from '@arco-design/web-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { CurriculumCoursePlanResponse } from '@/common/adapter/ipcBridge';
import type {
  Course,
  CourseCategory,
  CourseFilter,
  CourseStatus,
  ProgramPlan,
  StudentProgress,
  SyncState,
} from '../types';
import FloatingAIAssistant from './FloatingAIAssistant';

interface Props {
  plan: ProgramPlan;
  progress: StudentProgress;
  onCourseStatusChange: (courseId: string, status: CourseStatus) => void;
  onSync: () => Promise<boolean>;
  onClearProgress: () => Promise<boolean>;
  onViewHistory: () => void;
  onReupload: () => void;
  onBack: () => void;
  onCourseEdit: (
    courseId: string,
    updates: Partial<{
      name: string;
      credits: number;
      category: CourseCategory;
      categoryLabel: string;
      semester: number;
    }>
  ) => void;
}

const SEMESTER_LABELS = ['大一上', '大一下', '大二上', '大二下', '大三上', '大三下', '大四上', '大四下'];

const STATUS_META: Record<CourseStatus, { label: string; icon: string; color: string }> = {
  passed: { label: '已通过', icon: '✓', color: '#2f9e44' },
  failed: { label: '未通过', icon: '!', color: '#d9480f' },
  not_taken: { label: '未修读', icon: '○', color: '#868e96' },
};

const FILTERS: { key: CourseFilter; label: string }[] = [
  { key: 'all', label: '全部课程' },
  { key: 'required', label: '必修' },
  { key: 'elective', label: '选修' },
  { key: 'core', label: '专业核心' },
  { key: 'available', label: '当前可修' },
  { key: 'locked', label: '存在先修限制' },
];

function isAvailable(course: Course, statuses: Record<string, CourseStatus>): boolean {
  return course.prerequisites.every((pid) => statuses[pid] === 'passed');
}

const PathWorkbench: React.FC<Props> = ({
  plan,
  progress,
  onCourseStatusChange,
  onSync,
  onClearProgress,
  onViewHistory,
  onReupload,
  onBack,
  onCourseEdit,
}) => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [filter, setFilter] = useState<CourseFilter>('all');
  const [search, setSearch] = useState('');
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [coursePlanResult, setCoursePlanResult] = useState<{
    courseId: string;
    result: CurriculumCoursePlanResponse;
  } | null>(null);
  const [coursePlanLoading, setCoursePlanLoading] = useState(false);
  const [originalStatuses, setOriginalStatuses] = useState<Record<string, CourseStatus>>({});
  const dagRef = useRef<HTMLDivElement>(null);
  const dagContainerRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [lines, setLines] = useState<
    {
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      key: string;
      sourceId: string;
      targetId: string;
      kind: 'formal' | 'recommended';
    }[]
  >([]);

  const statuses = progress.courseStatuses;
  const isVerifiedCurriculum = plan.catalogVerified !== false && plan.id.startsWith('curriculum-');

  const stats = useMemo(() => {
    let passed = 0,
      failed = 0,
      notTaken = 0,
      earnedCredits = 0;
    plan.courses.forEach((c) => {
      const s = statuses[c.id] ?? 'not_taken';
      if (s === 'passed') {
        passed++;
        earnedCredits += c.credits;
      } else if (s === 'failed') failed++;
      else notTaken++;
    });
    return { passed, failed, notTaken, earnedCredits, totalCredits: plan.totalCredits };
  }, [plan.courses, statuses]);

  const pendingCount = useMemo(() => {
    return Object.keys(statuses).filter((id) => statuses[id] !== originalStatuses[id]).length;
  }, [statuses, originalStatuses]);

  useEffect(() => {
    setOriginalStatuses({ ...statuses });
  }, [plan.id, progress.lastSyncedAt]);

  const filteredCourses = useMemo(() => {
    return plan.courses.filter((c) => {
      if (search && !c.name.toLowerCase().includes(search.toLowerCase())) return false;
      switch (filter) {
        case 'required':
          return c.category === 'required' || c.category === 'general';
        case 'elective':
          return c.category === 'elective';
        case 'core':
          return c.category === 'core';
        case 'available':
          return isVerifiedCurriculum && isAvailable(c, statuses) && statuses[c.id] === 'not_taken';
        case 'locked':
          return isVerifiedCurriculum && !isAvailable(c, statuses) && statuses[c.id] === 'not_taken';
        default:
          return true;
      }
    });
  }, [plan.courses, filter, search, statuses, isVerifiedCurriculum]);

  const coursesBySemester = useMemo(() => {
    const map: Record<number, Course[]> = {};
    filteredCourses.forEach((c) => {
      if (!map[c.semester]) map[c.semester] = [];
      map[c.semester].push(c);
    });
    return map;
  }, [filteredCourses]);

  const semesterNumbers = useMemo(() => {
    const count = Math.max(8, ...plan.courses.map((course) => course.semester));
    return Array.from({ length: count }, (_, index) => index + 1);
  }, [plan.courses]);

  const selectedCourse = selectedCourseId ? plan.courses.find((c) => c.id === selectedCourseId) : null;
  useEffect(() => {
    setCoursePlanResult(null);
  }, [selectedCourseId, statuses]);

  const handlePlanCourse = useCallback(async () => {
    if (!selectedCourse || coursePlanLoading || !isVerifiedCurriculum) return;
    setCoursePlanLoading(true);
    try {
      const result = await ipcBridge.curriculum.planCourse.invoke({
        documentId: plan.id,
        major: plan.major,
        cohort: plan.grade,
        targetCourse: selectedCourse.id,
        completedCourses: Object.entries(statuses)
          .filter(([, status]) => status === 'passed')
          .map(([id]) => id),
      });
      setCoursePlanResult({ courseId: selectedCourse.id, result });
    } catch {
      setCoursePlanResult({
        courseId: selectedCourse.id,
        result: { ok: false, errorCode: 'COURSE_SERVER_UNAVAILABLE' },
      });
    } finally {
      setCoursePlanLoading(false);
    }
  }, [coursePlanLoading, plan.id, plan.major, plan.grade, selectedCourse, statuses, isVerifiedCurriculum]);
  const relatedIds = useMemo(() => {
    if (!selectedCourse) return new Set<string>();
    const ids = new Set<string>([selectedCourse.id]);
    const addPrereqs = (cid: string) => {
      const c = plan.courses.find((x) => x.id === cid);
      if (!c) return;
      c.prerequisites.forEach((pid) => {
        ids.add(pid);
        addPrereqs(pid);
      });
    };
    addPrereqs(selectedCourse.id);
    plan.courses.forEach((c) => {
      if (c.prerequisites.includes(selectedCourse.id)) ids.add(c.id);
    });
    plan.recommendedSequences?.forEach((edge) => {
      if (edge.from === selectedCourse.id) ids.add(edge.to);
      if (edge.to === selectedCourse.id) ids.add(edge.from);
    });
    return ids;
  }, [selectedCourse, plan.courses, plan.recommendedSequences]);

  useEffect(() => {
    if (!dagRef.current) return;
    const container = dagRef.current;
    const containerRect = container.getBoundingClientRect();
    const newLines: {
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      key: string;
      sourceId: string;
      targetId: string;
      kind: 'formal' | 'recommended';
    }[] = [];
    const formalPairs = new Set<string>();
    const visibleIds = new Set(filteredCourses.map((course) => course.id));

    filteredCourses.forEach((course) => {
      course.prerequisites.forEach((pid) => {
        if (!visibleIds.has(pid)) return;
        formalPairs.add(`${pid}->${course.id}`);
        const prereqNode = nodeRefs.current.get(pid);
        const courseNode = nodeRefs.current.get(course.id);
        if (prereqNode && courseNode) {
          const pr = prereqNode.getBoundingClientRect();
          const cr = courseNode.getBoundingClientRect();
          newLines.push({
            x1: pr.right - containerRect.left,
            y1: pr.top + pr.height / 2 - containerRect.top,
            x2: cr.left - containerRect.left,
            y2: cr.top + cr.height / 2 - containerRect.top,
            key: `${pid}-${course.id}`,
            sourceId: pid,
            targetId: course.id,
            kind: 'formal',
          });
        }
      });
    });
    plan.recommendedSequences?.forEach((edge) => {
      if (!visibleIds.has(edge.from) || !visibleIds.has(edge.to)) return;
      if (formalPairs.has(`${edge.from}->${edge.to}`)) return;
      const sourceNode = nodeRefs.current.get(edge.from);
      const targetNode = nodeRefs.current.get(edge.to);
      if (!sourceNode || !targetNode) return;
      const sourceRect = sourceNode.getBoundingClientRect();
      const targetRect = targetNode.getBoundingClientRect();
      newLines.push({
        x1: sourceRect.right - containerRect.left,
        y1: sourceRect.top + sourceRect.height / 2 - containerRect.top,
        x2: targetRect.left - containerRect.left,
        y2: targetRect.top + targetRect.height / 2 - containerRect.top,
        key: `sequence:${edge.from}-${edge.to}`,
        sourceId: edge.from,
        targetId: edge.to,
        kind: 'recommended',
      });
    });
    setLines(newLines);
  }, [filteredCourses, coursesBySemester, filter, search, plan.recommendedSequences]);

  const handleSync = useCallback(async () => {
    setSyncState('syncing');
    try {
      const saved = await onSync();
      if (!saved) {
        setSyncState('idle');
        Message.error(t('mcp.curriculumProgressSaveFailed'));
        return;
      }
      setOriginalStatuses({ ...statuses });
      setSyncState('success');
      setTimeout(() => setSyncState('idle'), 3000);
    } catch {
      setSyncState('idle');
      Message.error(t('mcp.curriculumProgressSaveFailed'));
    }
  }, [onSync, statuses, t]);

  const handleCancelChanges = useCallback(() => {
    Object.entries(originalStatuses).forEach(([id, s]) => onCourseStatusChange(id, s));
  }, [originalStatuses, onCourseStatusChange]);

  const handleClearProgress = useCallback(() => {
    Modal.confirm({
      title: t('mcp.curriculumProgressClearTitle'),
      content: t('mcp.curriculumProgressClearDescription'),
      onOk: async () => {
        if (!(await onClearProgress())) {
          Message.error(t('mcp.curriculumProgressClearFailed'));
          return Promise.reject(new Error('PROGRESS_CLEAR_FAILED'));
        }
        setOriginalStatuses(Object.fromEntries(plan.courses.map((course) => [course.id, 'not_taken'])));
        setSyncState('idle');
        Message.success(t('mcp.curriculumProgressCleared'));
      },
    });
  }, [onClearProgress, plan.courses, t]);

  // DAG 左右滚动
  const scrollDag = useCallback((dir: 'left' | 'right') => {
    if (!dagContainerRef.current) return;
    const amount = dagContainerRef.current.clientWidth * 0.7;
    dagContainerRef.current.scrollBy({ left: dir === 'left' ? -amount : amount, behavior: 'smooth' });
  }, []);

  const selectedPrereqs = selectedCourse?.prerequisites
    .map((pid) => plan.courses.find((c) => c.id === pid))
    .filter(Boolean) as Course[];
  const selectedSuccessors = plan.courses.filter((c) => c.prerequisites.includes(selectedCourseId ?? ''));

  return (
    <div className='ap-workbench'>
      {/* 顶部 */}
      <header className='ap-workbench__header'>
        <div className='ap-workbench__header-left'>
          <button type='button' className='ap-back' onClick={onBack}>
            ← 返回
          </button>
          <div>
            <h1 className='ap-workbench__title'>我的学业路径</h1>
            <p className='ap-workbench__subtitle'>
              {plan.major} · {plan.grade}培养方案
            </p>
          </div>
        </div>
        <div className='ap-workbench__header-actions'>
          <button
            type='button'
            className='ap-btn ap-btn--ghost ap-home-btn'
            onClick={() => navigate('/')}
            title='返回首页'
          >
            <Home size={15} theme='outline' fill='currentColor' />
          </button>
          <button type='button' className='ap-btn ap-btn--primary' onClick={onViewHistory}>
            培养方案历史
          </button>
          <button type='button' className='ap-btn ap-btn--primary' onClick={onReupload}>
            重新导入
          </button>
          <Button onClick={handleClearProgress} disabled={syncState === 'syncing'}>
            {t('mcp.curriculumProgressClearButton')}
          </Button>
        </div>
      </header>

      {/* 统计卡片 */}
      <div className='ap-workbench__stats'>
        <div className='ap-stat ap-stat--passed'>
          <div className='ap-stat__value'>{stats.passed}</div>
          <div className='ap-stat__label'>已通过</div>
        </div>
        <div className='ap-stat ap-stat--failed'>
          <div className='ap-stat__value'>{stats.failed}</div>
          <div className='ap-stat__label'>未通过</div>
        </div>
        <div className='ap-stat ap-stat--pending'>
          <div className='ap-stat__value'>{stats.notTaken}</div>
          <div className='ap-stat__label'>未修读</div>
        </div>
        <div className='ap-stat ap-stat--credits'>
          <div className='ap-stat__value'>
            {stats.earnedCredits}
            <span className='ap-stat__total'> / {stats.totalCredits ?? '—'}</span>
          </div>
          <div className='ap-stat__label'>已获学分</div>
        </div>
      </div>

      {/* 筛选工具栏 */}
      <div className='ap-workbench__toolbar'>
        <div className='ap-workbench__filters'>
          {FILTERS.filter((item) => isVerifiedCurriculum || (item.key !== 'available' && item.key !== 'locked')).map(
            (f) => (
              <button
                key={f.key}
                type='button'
                className={`ap-filter-btn ${filter === f.key ? 'ap-filter-btn--active' : ''}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            )
          )}
        </div>
        <div className='ap-workbench__search'>
          <span className='ap-workbench__search-icon'>⌕</span>
          <input type='text' placeholder='搜索课程名称' value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {/* DAG 区域 */}
      {plan.recommendedSequences?.length ? (
        <p className='mb-2 text-t-secondary text-12px'>
          {t('mcp.curriculumRecommendedSequenceLegend', { count: plan.recommendedSequences.length })}
        </p>
      ) : null}
      <div className='ap-workbench__dag-wrapper'>
        <button
          type='button'
          className='ap-dag__scroll-btn ap-dag__scroll-btn--left'
          onClick={() => scrollDag('left')}
          aria-label='向左滚动'
        >
          ‹
        </button>
        <div className='ap-workbench__dag-container' ref={dagContainerRef}>
          <div className='ap-dag' ref={dagRef}>
            <svg
              className='ap-dag__lines'
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
            >
              {lines.map((l) => {
                const isHighlighted =
                  selectedCourseId &&
                  (l.sourceId === selectedCourseId ||
                    l.targetId === selectedCourseId ||
                    relatedIds.has(l.sourceId) ||
                    relatedIds.has(l.targetId));
                const midX = (l.x1 + l.x2) / 2;
                return (
                  <path
                    key={l.key}
                    d={`M ${l.x1} ${l.y1} C ${midX} ${l.y1}, ${midX} ${l.y2}, ${l.x2} ${l.y2}`}
                    fill='none'
                    stroke={isHighlighted ? '#5f8575' : '#c5cdd6'}
                    strokeWidth={isHighlighted ? 2 : 1.2}
                    strokeDasharray={l.kind === 'recommended' ? '6 4' : undefined}
                    opacity={selectedCourseId && !isHighlighted ? 0.2 : 0.7}
                  />
                );
              })}
            </svg>

            {semesterNumbers.map((sem) => (
              <div key={sem} className='ap-dag__column'>
                <div className='ap-dag__semester-label'>
                  {SEMESTER_LABELS[sem - 1] ?? t('mcp.curriculumSemesterNumber', { number: sem })}
                </div>
                {(coursesBySemester[sem] || []).map((course) => {
                  const status = statuses[course.id] ?? 'not_taken';
                  const meta = STATUS_META[status];
                  const available = isVerifiedCurriculum && isAvailable(course, statuses);
                  const isSelected = selectedCourseId === course.id;
                  const isRelated = relatedIds.has(course.id);
                  const dimmed = selectedCourseId && !isRelated;
                  return (
                    <div
                      key={course.id}
                      ref={(el) => {
                        if (el) nodeRefs.current.set(course.id, el);
                      }}
                      className={`ap-course-node ap-course-node--${status} ${isSelected ? 'ap-course-node--selected' : ''} ${dimmed ? 'ap-course-node--dimmed' : ''}`}
                      onClick={() => setSelectedCourseId(isSelected ? null : course.id)}
                    >
                      <div className='ap-course-node__header'>
                        <span className='ap-course-node__name'>{course.name}</span>
                        <span className='ap-course-node__credits'>{course.credits}学分</span>
                      </div>
                      <div className='ap-course-node__category'>{course.categoryLabel}</div>
                      <div className='ap-course-node__status' style={{ color: meta.color }}>
                        {meta.icon} {meta.label}
                        {isVerifiedCurriculum && status === 'not_taken' && available && (
                          <span className='ap-course-node__available'>✦ 当前可修</span>
                        )}
                        {isVerifiedCurriculum && status === 'not_taken' && !available && (
                          <span className='ap-course-node__locked'>🔒 暂不可修</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        <button
          type='button'
          className='ap-dag__scroll-btn ap-dag__scroll-btn--right'
          onClick={() => scrollDag('right')}
          aria-label='向右滚动'
        >
          ›
        </button>
      </div>

      {/* 课程详情面板 */}
      {selectedCourse && (
        <div className='ap-detail-panel'>
          <div className='ap-detail-panel__header'>
            <h3 className='ap-detail-panel__title'>{selectedCourse.name}</h3>
            <button type='button' className='ap-detail-panel__close' onClick={() => setSelectedCourseId(null)}>
              ✕
            </button>
          </div>
          <div className='ap-detail-panel__body'>
            {/* 课程名称 - 可编辑 */}
            <div className='ap-detail-panel__edit-row'>
              <span className='ap-detail-panel__label'>课程名称</span>
              <input
                disabled={isVerifiedCurriculum}
                type='text'
                className='ap-detail-input'
                value={selectedCourse.name}
                onChange={(e) => onCourseEdit(selectedCourse.id, { name: e.target.value })}
              />
            </div>
            {/* 学分 - 可编辑 */}
            <div className='ap-detail-panel__edit-row'>
              <span className='ap-detail-panel__label'>学分</span>
              <input
                disabled={isVerifiedCurriculum}
                type='number'
                min={0}
                max={20}
                step={0.5}
                className='ap-detail-input ap-detail-input--num'
                value={selectedCourse.credits}
                onChange={(e) => onCourseEdit(selectedCourse.id, { credits: Number(e.target.value) || 0 })}
              />
            </div>
            {/* 课程类别 - 可编辑 */}
            <div className='ap-detail-panel__edit-row'>
              <span className='ap-detail-panel__label'>课程类别</span>
              <select
                disabled={isVerifiedCurriculum}
                className='ap-detail-input'
                value={selectedCourse.category}
                onChange={(e) => {
                  const map: Record<string, string> = {
                    general: '公共基础课',
                    core: '专业核心课',
                    required: '必修课',
                    elective: '专业选修课',
                    practice: '实践环节',
                    other: t('mcp.curriculumOtherCategory'),
                  };
                  onCourseEdit(selectedCourse.id, {
                    category: e.target.value as CourseCategory,
                    categoryLabel: map[e.target.value] || e.target.value,
                  });
                }}
              >
                <option value='general'>公共基础课</option>
                <option value='core'>专业核心课</option>
                <option value='required'>必修课</option>
                <option value='elective'>专业选修课</option>
                <option value='practice'>实践环节</option>
                <option value='other'>{t('mcp.curriculumOtherCategory')}</option>
              </select>
            </div>
            {/* 建议学期 - 可编辑 */}
            <div className='ap-detail-panel__edit-row'>
              <span className='ap-detail-panel__label'>建议学期</span>
              <select
                disabled={isVerifiedCurriculum}
                className='ap-detail-input'
                value={selectedCourse.semester}
                onChange={(e) => onCourseEdit(selectedCourse.id, { semester: Number(e.target.value) })}
              >
                {SEMESTER_LABELS.map((label, i) => (
                  <option key={i + 1} value={i + 1}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            {isVerifiedCurriculum && (
              <div className='ap-detail-panel__relation'>{t('mcp.curriculumRulesReadOnly')}</div>
            )}

            <div className='ap-detail-panel__section'>
              <div className='ap-detail-panel__section-title'>修读状态</div>
              <div className='ap-detail-panel__status-options'>
                {(['not_taken', 'passed', 'failed'] as CourseStatus[]).map((s) => (
                  <button
                    key={s}
                    type='button'
                    disabled={syncState === 'syncing'}
                    className={`ap-status-option ${statuses[selectedCourse.id] === s ? 'ap-status-option--active' : ''}`}
                    style={{ '--status-color': STATUS_META[s].color } as React.CSSProperties}
                    onClick={() => onCourseStatusChange(selectedCourse.id, s)}
                  >
                    {STATUS_META[s].icon} {STATUS_META[s].label}
                  </button>
                ))}
              </div>
            </div>

            <div className='ap-detail-panel__section'>
              <Button onClick={handlePlanCourse} loading={coursePlanLoading} disabled={!isVerifiedCurriculum}>
                {t('mcp.curriculumCheckCourse')}
              </Button>
              {coursePlanResult?.courseId === selectedCourse.id && (
                <div className='ap-detail-panel__relation'>
                  {!coursePlanResult.result.ok ? (
                    <span>
                      {t('mcp.curriculumCheckFailed')}: {coursePlanResult.result.errorCode}
                    </span>
                  ) : (
                    <div>
                      <div>
                        {coursePlanResult.result.status === 'ELIGIBLE'
                          ? t('mcp.curriculumCourseEligible')
                          : t('mcp.curriculumCourseNotEligible')}
                      </div>
                      <div>
                        {t('mcp.curriculumMissingDirect')}:{' '}
                        {coursePlanResult.result.missingDirectPrerequisites
                          ?.map((course) => course.courseName)
                          .join('、') || t('mcp.curriculumNone')}
                      </div>
                      <div>
                        {t('mcp.curriculumMissingChain')}:{' '}
                        {coursePlanResult.result.missingCourses?.map((course) => course.courseName).join('、') ||
                          t('mcp.curriculumNone')}
                      </div>
                      <div>
                        {t('mcp.curriculumEvidence')}: {coursePlanResult.result.source?.document ?? '—'}
                        {coursePlanResult.result.source?.page
                          ? ` · ${t('mcp.curriculumPage', { number: coursePlanResult.result.source.page })}`
                          : ''}
                      </div>
                      {coursePlanResult.result.warnings?.length ? (
                        <div>
                          {t('mcp.curriculumWarnings')}: {coursePlanResult.result.warnings.join(', ')}
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              )}
            </div>

            {selectedPrereqs.length > 0 && (
              <div className='ap-detail-panel__section'>
                <div className='ap-detail-panel__section-title'>先修课程</div>
                {selectedPrereqs.map((p) => (
                  <div key={p.id} className='ap-detail-panel__relation'>
                    <span className={`ap-detail-panel__relation-status ${statuses[p.id] ?? 'not_taken'}`}>
                      {STATUS_META[statuses[p.id] ?? 'not_taken'].icon}
                    </span>
                    <span>{p.name}</span>
                  </div>
                ))}
              </div>
            )}

            {selectedSuccessors.length > 0 && (
              <div className='ap-detail-panel__section'>
                <div className='ap-detail-panel__section-title'>后续课程</div>
                {selectedSuccessors.map((s) => (
                  <div key={s.id} className='ap-detail-panel__relation'>
                    <span>→</span>
                    <span>{s.name}</span>
                  </div>
                ))}
              </div>
            )}

            {statuses[selectedCourse.id] === 'not_taken' && !isAvailable(selectedCourse, statuses) && (
              <div className='ap-detail-panel__warning'>
                🔒 暂不可修，缺少先修课程：
                {selectedPrereqs
                  .filter((p) => statuses[p.id] !== 'passed')
                  .map((p) => p.name)
                  .join('、')}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 悬浮 AI 助手 */}
      <FloatingAIAssistant selectedCourse={selectedCourse} plan={plan} progress={progress} />

      {/* 同步状态栏 */}
      {pendingCount > 0 && syncState === 'idle' && (
        <div className='ap-sync-bar'>
          <span className='ap-sync-bar__text'>有 {pendingCount} 项学业状态尚未同步</span>
          <div className='ap-sync-bar__actions'>
            <button type='button' className='ap-btn ap-btn--ghost' onClick={handleCancelChanges}>
              取消修改
            </button>
            <button type='button' className='ap-btn ap-btn--primary' onClick={handleSync}>
              确认并同步学业状态
            </button>
          </div>
        </div>
      )}
      {syncState === 'syncing' && (
        <div className='ap-sync-bar ap-sync-bar--syncing'>
          <div className='ap-sync-bar__spinner' />
          <span>正在同步你的学业状态……</span>
        </div>
      )}
      {syncState === 'success' && (
        <div className='ap-sync-bar ap-sync-bar--success'>
          <span>{t('mcp.curriculumProgressSaved')}</span>
          <span className='ap-sync-bar__time'>最后同步：刚刚</span>
        </div>
      )}
    </div>
  );
};

export default PathWorkbench;
