/** Curriculum import and front-end graph adaptation. Importing does not imply extraction. */
import { ipcBridge } from '@/common';
import type { CurriculumGraph, CurriculumIngestRequest, CurriculumPlanPreview } from '@/common/adapter/ipcBridge';
import type { Course, CourseCategory, ProgramPlan } from './types';

export type McpProgramPlanResult = CurriculumPlanPreview;

export type ParseResult =
  | { type: 'stored'; documentId: string; created: boolean; extractionStatus?: string; ragStatus?: string }
  | { type: 'failed'; errorCode: string };

export type GraphLoadResult =
  | { type: 'ready'; plan: ProgramPlan; warnings?: string[] }
  | {
      type: 'failed';
      errorCode: string;
      processingStatus?: string;
      failedPage?: number;
      failureCode?: string;
      failureStage?: string;
      failureReason?: string;
    };

/** Store the selected source. Graph generation is a separate, explicit next stage. */
export async function parseProgramPlan(request: CurriculumIngestRequest): Promise<ParseResult> {
  try {
    const result = await ipcBridge.curriculum.ingestAttachment.invoke(request);
    if (!result.ok || !result.documentId) {
      return { type: 'failed', errorCode: result.errorCode ?? 'INGEST_FAILED' };
    }
    return {
      type: 'stored',
      documentId: result.documentId,
      created: result.created === true,
      extractionStatus: result.extractionStatus,
      ragStatus: result.ragStatus,
    };
  } catch {
    return { type: 'failed', errorCode: 'COURSE_SERVER_UNAVAILABLE' };
  }
}

function categoryFromLabel(label: string): CourseCategory {
  if (label.includes('核心')) return 'core';
  if (label.includes('实践') || label.includes('实验') || label.includes('实习')) return 'practice';
  if (label.includes('通识') || label.includes('公共')) return 'general';
  if (label.includes('选修')) return 'elective';
  if (label.includes('必修')) return 'required';
  return 'other';
}

/** Adapt only server-validated graph data; unknown categories remain explicitly "other". */
export function adaptCurriculumGraph(graph: CurriculumGraph): ProgramPlan {
  const courses: Course[] = graph.courses.map((course) => ({
    id: course.id,
    name: course.name,
    credits: course.credits,
    category: categoryFromLabel(course.category_label),
    categoryLabel: course.category_label,
    semester: course.suggested_semester,
    prerequisites: course.prerequisites,
  }));
  return {
    id: graph.document_id,
    name: graph.document.replace(/\.(pdf|jpg|jpeg|png)$/i, ''),
    major: graph.major,
    grade: graph.cohort,
    version: graph.version,
    totalCredits: graph.total_credits,
    courses,
    catalogVerified: true,
    createdAt: new Date().toISOString(),
    isCurrent: false,
  };
}

export async function loadProgramGraph(documentId: string): Promise<GraphLoadResult> {
  try {
    const result = await ipcBridge.curriculum.prepareGraph.invoke({ documentId });
    if (!result.ok || !result.graph) {
      return {
        type: 'failed',
        errorCode: result.errorCode ?? 'GRAPH_FAILED',
        processingStatus: result.processingStatus,
        failedPage: result.failedPage,
        failureCode: result.failureCode,
        failureStage: result.failureStage,
        failureReason: result.failureReason,
      };
    }
    return { type: 'ready', plan: adaptCurriculumGraph(result.graph) };
  } catch {
    return { type: 'failed', errorCode: 'COURSE_SERVER_UNAVAILABLE' };
  }
}

/** Adapt a course preview for both the normal upload flow and the JSON debug panel. */
export function adaptMcpPlan(raw: McpProgramPlanResult, fileName?: string, documentId?: string): ProgramPlan {
  if (!raw.major || !Array.isArray(raw.courses) || raw.courses.length === 0) {
    throw new Error('Invalid graph data');
  }
  const courses: Course[] = raw.courses.map((course) => ({
    id: course.id,
    name: course.name,
    credits: course.credits,
    category: course.category,
    categoryLabel: course.categoryLabel,
    semester: course.suggestedSemester,
    prerequisites: course.prerequisites ?? [],
  }));
  return {
    id: documentId ?? `plan-${Date.now()}`,
    name: fileName ? fileName.replace(/\.(pdf|doc|docx|jpg|jpeg|png|json)$/i, '') : raw.major,
    major: raw.major,
    grade: raw.grade,
    version: raw.version ?? '',
    totalCredits: raw.totalCredits,
    courses,
    recommendedSequences: raw.recommendedSequences ?? [],
    catalogVerified: false,
    createdAt: new Date().toISOString(),
    isCurrent: false,
  };
}

/** Fast PDF preview after ingestion; this does not claim verified prerequisites. */
export async function loadProgramPreview(filePath: string, documentId: string): Promise<GraphLoadResult> {
  try {
    const result = await ipcBridge.curriculum.previewPlan.invoke({ filePath });
    if (!result.ok || !result.plan) return { type: 'failed', errorCode: result.errorCode ?? 'PARSE_FAILED' };
    const fileName = filePath.split(/[\\/]/).pop();
    return {
      type: 'ready',
      plan: adaptMcpPlan(result.plan, fileName, documentId),
      warnings: result.plan.warnings ?? [],
    };
  } catch {
    return { type: 'failed', errorCode: 'COURSE_SERVER_UNAVAILABLE' };
  }
}
