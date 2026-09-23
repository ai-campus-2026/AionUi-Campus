import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  onSync: () => void;
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
      gpa?: number;
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
  onReupload,
  onBack,
  onCourseEdit,
}) => {
  const [filter, setFilter] = useState<CourseFilter>('all');
  const [search, setSearch] = useState('');
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  const [gpaInput, setGpaInput] = useState('');
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [originalStatuses, setOriginalStatuses] = useState<Record<string, CourseStatus>>({});
  const dagRef = useRef<HTMLDivElement>(null);
  const dagContainerRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [lines, setLines] = useState<{ x1: number; y1: number; x2: number; y2: number; key: string }[]>([]);

  const statuses = progress.courseStatuses;

  const stats = useMemo(() => {
    let passed = 0,
      failed = 0,
      notTaken = 0,
      earnedCredits = 0;
    let totalGpaPoints = 0;
    let totalGpaCredits = 0;
    let requiredGpaPoints = 0;
    let requiredGpaCredits = 0;
    plan.courses.forEach((c) => {
      const s = statuses[c.id] ?? 'not_taken';
      if (s === 'passed') {
        passed++;
        earnedCredits += c.credits;
      } else if (s === 'failed') failed++;
      else notTaken++;
      if (s === 'passed' && typeof c.gpa === 'number') {
        totalGpaPoints += c.credits * c.gpa;
        totalGpaCredits += c.credits;
        const isRequired =
          c.category === 'required' || c.category === 'core' || c.category === 'general' || c.category === 'practice';
        if (isRequired) {
          requiredGpaPoints += c.credits * c.gpa;
          requiredGpaCredits += c.credits;
        }
      }
    });
    const totalGpa = totalGpaCredits > 0 ? totalGpaPoints / totalGpaCredits : 0;
    const requiredGpa = requiredGpaCredits > 0 ? requiredGpaPoints / requiredGpaCredits : 0;
    return { passed, failed, notTaken, earnedCredits, totalCredits: plan.totalCredits, totalGpa, requiredGpa };
  }, [plan, statuses]);
  const pendingCount = useMemo(() => {
    return Object.keys(statuses).filter((id) => statuses[id] !== originalStatuses[id]).length;
  }, [statuses, originalStatuses]);

  useEffect(() => {
    setOriginalStatuses({ ...statuses });
  }, [plan.id]);

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
          return isAvailable(c, statuses) && statuses[c.id] === 'not_taken';
        case 'locked':
          return !isAvailable(c, statuses) && statuses[c.id] === 'not_taken';
        default:
          return true;
      }
    });
  }, [plan.courses, filter, search, statuses]);

  const coursesBySemester = useMemo(() => {
    const map: Record<number, Course[]> = {};
    filteredCourses.forEach((c) => {
      if (!map[c.semester]) map[c.semester] = [];
      map[c.semester].push(c);
    });
    return map;
  }, [filteredCourses]);

  const selectedCourse = selectedCourseId ? plan.courses.find((c) => c.id === selectedCourseId) : null;

  useEffect(() => {
    if (selectedCourse) {
      setGpaInput(selectedCourse.gpa !== undefined ? String(selectedCourse.gpa) : '');
    }
  }, [selectedCourseId, selectedCourse?.gpa, selectedCourse?.category]);
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
    return ids;
  }, [selectedCourse, plan.courses]);

  useEffect(() => {
    if (!dagRef.current) return;
    const container = dagRef.current;
    const containerRect = container.getBoundingClientRect();
    const newLines: { x1: number; y1: number; x2: number; y2: number; key: string }[] = [];

    filteredCourses.forEach((course) => {
      course.prerequisites.forEach((pid) => {
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
          });
        }
      });
    });
    setLines(newLines);
  }, [filteredCourses, coursesBySemester, filter, search]);

  const handleSync = useCallback(() => {
    setSyncState('syncing');
    setTimeout(() => {
      onSync();
      setOriginalStatuses({ ...statuses });
      setSyncState('success');
      setTimeout(() => setSyncState('idle'), 3000);
    }, 1200);
  }, [onSync, statuses]);

  const handleCancelChanges = useCallback(() => {
    Object.entries(originalStatuses).forEach(([id, s]) => onCourseStatusChange(id, s));
  }, [originalStatuses, onCourseStatusChange]);

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
          <button type='button' className='ap-btn ap-btn--primary' onClick={onReupload}>
            重新导入
          </button>
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
            <span className='ap-stat__total'> / {stats.totalCredits}</span>
          </div>
          <div className='ap-stat__label'>已获学分</div>
        </div>
        <div className='ap-stat'>
          <div className='ap-stat__value'>{stats.totalGpa.toFixed(2)}</div>
          <div className='ap-stat__label'>总绩点</div>
        </div>
        <div className='ap-stat'>
          <div className='ap-stat__value'>{stats.requiredGpa.toFixed(2)}</div>
          <div className='ap-stat__label'>必修绩点</div>
        </div>
      </div>
      {/* 筛选工具栏 */}
      <div className='ap-workbench__toolbar'>
        <div className='ap-workbench__filters'>
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type='button'
              className={`ap-filter-btn ${filter === f.key ? 'ap-filter-btn--active' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className='ap-workbench__search'>
          <span className='ap-workbench__search-icon'>⌕</span>
          <input type='text' placeholder='搜索课程名称' value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {/* DAG 区域 */}
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
                  (l.key.includes(selectedCourseId) ||
                    relatedIds.has(l.key.split('-')[0]) ||
                    relatedIds.has(l.key.split('-')[1]));
                const midX = (l.x1 + l.x2) / 2;
                return (
                  <path
                    key={l.key}
                    d={`M ${l.x1} ${l.y1} C ${midX} ${l.y1}, ${midX} ${l.y2}, ${l.x2} ${l.y2}`}
                    fill='none'
                    stroke={isHighlighted ? '#5f8575' : '#c5cdd6'}
                    strokeWidth={isHighlighted ? 2 : 1.2}
                    opacity={selectedCourseId && !isHighlighted ? 0.2 : 0.7}
                  />
                );
              })}
            </svg>

            {[1, 2, 3, 4, 5, 6, 7, 8].map((sem) => (
              <div key={sem} className='ap-dag__column'>
                <div className='ap-dag__semester-label'>{SEMESTER_LABELS[sem - 1]}</div>
                {(coursesBySemester[sem] || []).map((course) => {
                  const status = statuses[course.id] ?? 'not_taken';
                  const meta = STATUS_META[status];
                  const available = isAvailable(course, statuses);
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
                        <span className='ap-course-node__credits'>
                          {course.credits}学分
                          {typeof course.gpa === 'number' && status === 'passed'
                            ? ` · ${course.gpa.toFixed(1)}绩点`
                            : ''}
                        </span>
                      </div>
                      <div className='ap-course-node__category'>{course.categoryLabel}</div>
                      <div className='ap-course-node__status' style={{ color: meta.color }}>
                        {meta.icon} {meta.label}
                        {status === 'not_taken' && available && (
                          <span className='ap-course-node__available'>✦ 当前可修</span>
                        )}
                        {status === 'not_taken' && !available && (
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
                type='number'
                min={0}
                max={20}
                step={0.5}
                className='ap-detail-input ap-detail-input--num'
                value={selectedCourse.credits}
                onChange={(e) => onCourseEdit(selectedCourse.id, { credits: Number(e.target.value) || 0 })}
              />
            </div>
            {/* 绩点 - 可编辑 */}
            <div className='ap-detail-panel__edit-row'>
              <span className='ap-detail-panel__label'>绩点</span>
              <input
                type='text'
                inputMode='decimal'
                className='ap-detail-input ap-detail-input--num'
                value={gpaInput}
                placeholder='未填写'
                onChange={(e) => setGpaInput(e.target.value)}
                onBlur={() => {
                  const val = gpaInput.trim();
                  if (val === '') {
                    onCourseEdit(selectedCourse.id, { gpa: undefined });
                  } else {
                    const num = Number(val);
                    if (!isNaN(num)) {
                      onCourseEdit(selectedCourse.id, { gpa: num });
                    }
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
              />
            </div>
            {/* 课程类别 - 可编辑 */}
            <div className='ap-detail-panel__edit-row'>
              <span className='ap-detail-panel__label'>课程类别</span>
              <select
                className='ap-detail-input'
                value={selectedCourse.category}
                onChange={(e) => {
                  const map: Record<string, string> = {
                    general: '公共基础课',
                    core: '专业核心课',
                    required: '必修课',
                    elective: '专业选修课',
                    practice: '实践环节',
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
              </select>
            </div>
            {/* 建议学期 - 可编辑 */}
            <div className='ap-detail-panel__edit-row'>
              <span className='ap-detail-panel__label'>建议学期</span>
              <select
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

            <div className='ap-detail-panel__section'>
              <div className='ap-detail-panel__section-title'>修读状态</div>
              <div className='ap-detail-panel__status-options'>
                {(['not_taken', 'passed', 'failed'] as CourseStatus[]).map((s) => (
                  <button
                    key={s}
                    type='button'
                    className={`ap-status-option ${statuses[selectedCourse.id] === s ? 'ap-status-option--active' : ''}`}
                    style={{ '--status-color': STATUS_META[s].color } as React.CSSProperties}
                    onClick={() => onCourseStatusChange(selectedCourse.id, s)}
                  >
                    {STATUS_META[s].icon} {STATUS_META[s].label}
                  </button>
                ))}
              </div>
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
          <span>✓ 学业状态已同步，AI 已可以使用最新学业状态进行规划</span>
          <span className='ap-sync-bar__time'>最后同步：刚刚</span>
        </div>
      )}
    </div>
  );
};

export default PathWorkbench;
