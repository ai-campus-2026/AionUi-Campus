/**
 * 学业路径模块数据类型
 * 培养方案版本 与 学生学业状态 严格区分
 */

/** 课程类别 */
export type CourseCategory = 'required' | 'elective' | 'core' | 'general' | 'practice' | 'other';

/** 课程修读状态 */
export type CourseStatus = 'not_taken' | 'passed' | 'failed';

/** 课程 */
export interface Course {
  id: string;
  name: string;
  credits: number;
  category: CourseCategory;
  categoryLabel: string;
  /** 建议学期 1-8 */
  semester: number;
  /** 先修课程 ID 列表 */
  prerequisites: string[];
  description?: string;
}

/** 培养方案（决定有哪些课、学分、先修关系） */
export interface ProgramPlan {
  id: string;
  name: string;
  major: string;
  grade: string;
  version: string;
  /** Graduation requirement, null when the source has no verified total. */
  totalCredits: number | null;
  courses: Course[];
  /** Preview-only guidance; never used for enrollment eligibility. */
  recommendedSequences?: { from: string; to: string; page: number }[];
  /** False when imported from the unverified PDF preview. */
  catalogVerified?: boolean;
  createdAt: string;
  confirmedAt?: string;
  isCurrent: boolean;
  /** 解析时不确定的先修关系，待用户确认 */
  uncertainRelations?: {
    courseId: string;
    prerequisiteId: string;
    question: string;
  }[];
}

/** 学生学业状态（决定每门课修没修、过没过） */
export interface StudentProgress {
  planId: string;
  /** courseId -> 修读状态 */
  courseStatuses: Record<string, CourseStatus>;
  lastSyncedAt?: string;
}

/** 学业路径页面视图状态 */
export type PathView = 'empty' | 'parsing' | 'confirm' | 'workbench' | 'history';

/** 筛选条件 */
export type CourseFilter = 'all' | 'required' | 'elective' | 'core' | 'available' | 'locked';

/** 同步状态 */
export type SyncState = 'idle' | 'pending' | 'syncing' | 'success';
