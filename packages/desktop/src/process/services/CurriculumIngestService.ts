import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { IMcpServer } from '@/common/config/storage';
import type {
  CurriculumGraph,
  CurriculumGraphResponse,
  CurriculumProbeMode,
  CurriculumProbeResponse,
  CurriculumIngestRequest,
  CurriculumIngestResponse,
  CurriculumPlanPreview,
  CurriculumPlanPreviewResponse,
  CurriculumProgressRequest,
  CurriculumProgressClearResponse,
  CurriculumProgressResponse,
  CurriculumCoursePlanRequest,
  CurriculumCoursePlanResponse,
} from '@/common/adapter/ipcBridge';
import { mcpService } from '@/common/adapter/ipcBridge';

type CourseTool =
  | 'curriculum_ingest_from_attachment'
  | 'parse_program_plan'
  | 'curriculum_graph'
  | 'retry_curriculum_extraction'
  | 'curriculum_extraction_probe'
  | 'save_course_progress'
  | 'load_course_progress'
  | 'clear_course_progress'
  | 'course_path_plan';
const SERVER_NAMES = new Set(['course_path_server', 'course-path-server']);
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === 'string' ? record[key] : undefined;
}

function cwdFromOriginalConfig(server: IMcpServer): string | undefined {
  try {
    const original: unknown = JSON.parse(server.original_json);
    if (!isRecord(original)) return undefined;
    const servers = isRecord(original.mcpServers) ? original.mcpServers : {};
    const rawConfig = servers[server.name];
    const config: Record<string, unknown> = isRecord(rawConfig) ? rawConfig : {};
    return field(config, 'cwd');
  } catch {
    return undefined;
  }
}

class CourseServerNotConfigured extends Error {}

/** Direct, fixed-purpose invocation of the user's configured course-path stdio server. */
async function invokeCourseTool(
  name: CourseTool,
  arguments_: Record<string, unknown>,
  timeout: number
): Promise<unknown> {
  const serverResult: unknown = await mcpService.listServers.invoke();
  const servers: IMcpServer[] = Array.isArray(serverResult) ? (serverResult as IMcpServer[]) : [];
  const server = servers.find((item) => SERVER_NAMES.has(item.name) && item.enabled !== false);
  if (!server || server.transport.type !== 'stdio') throw new CourseServerNotConfigured();

  const transport = new StdioClientTransport({
    command: server.transport.command,
    args: server.transport.args ?? [],
    env: { ...getDefaultEnvironment(), ...server.transport.env },
    cwd: cwdFromOriginalConfig(server),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'aionui-curriculum', version: '0.1.0' });
  try {
    await client.connect(transport, { timeout: 10_000 });
    const result: unknown = await client.callTool({ name, arguments: arguments_ }, undefined, { timeout });
    const response = isRecord(result) ? result : {};
    const content: unknown[] = Array.isArray(response.content) ? response.content : [];
    const textContent = content.find((item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string');
    return response.structuredContent ?? (isRecord(textContent) ? JSON.parse(String(textContent.text)) : null);
  } finally {
    await client.close().catch((): void => undefined);
  }
}

/** Convert the MCP envelope to a small result without returning local paths or credentials. */
export function summarizeCurriculumIngest(value: unknown): CurriculumIngestResponse {
  if (!isRecord(value)) return { ok: false, errorCode: 'INVALID_RESPONSE' };
  if (value.ok !== true) {
    const error = isRecord(value.error) ? value.error : {};
    return { ok: false, errorCode: field(error, 'code') ?? 'INGEST_FAILED' };
  }
  const data = isRecord(value.data) ? value.data : {};
  const document = isRecord(data.document) ? data.document : {};
  const rag = isRecord(data.rag_index) ? data.rag_index : {};
  const documentId = field(document, 'document_id');
  if (!documentId || field(document, 'storage_status') !== 'SOURCE_STORED') {
    return { ok: false, errorCode: 'INVALID_RESPONSE' };
  }
  const extraction = isRecord(data.extraction) ? data.extraction : {};
  return {
    ok: true,
    created: data.created === true,
    documentId,
    storageStatus: field(document, 'storage_status'),
    extractionStatus: field(extraction, 'status') ?? field(document, 'extraction_status'),
    ragStatus: field(document, 'rag_status') ?? field(rag, 'status'),
  };
}

/** Accept only a complete, internally consistent preview; this is not a verified catalog. */
export function summarizeCurriculumPlanPreview(value: unknown): CurriculumPlanPreviewResponse {
  if (!isRecord(value)) return { ok: false, errorCode: 'INVALID_RESPONSE' };
  if (value.success !== true) return { ok: false, errorCode: field(value, 'errorCode') ?? 'PARSE_FAILED' };
  if (
    !field(value, 'major') ||
    !/^(?:20\d{2}|未注明)$/.test(field(value, 'grade') ?? '') ||
    typeof value.totalCredits !== 'number' ||
    !Number.isFinite(value.totalCredits) ||
    value.totalCredits < 0 ||
    !Array.isArray(value.courses) ||
    value.courses.length === 0
  ) {
    return { ok: false, errorCode: 'INVALID_RESPONSE' };
  }
  const categories = new Set(['required', 'elective', 'core', 'general', 'practice']);
  const ids = new Set<string>();
  const semesters = new Map<string, number>();
  for (const course of value.courses) {
    if (
      !isRecord(course) ||
      !field(course, 'id') ||
      !field(course, 'name') ||
      typeof course.credits !== 'number' ||
      !Number.isFinite(course.credits) ||
      course.credits <= 0 ||
      !categories.has(field(course, 'category') ?? '') ||
      !field(course, 'categoryLabel') ||
      !Number.isInteger(course.suggestedSemester) ||
      (course.suggestedSemester as number) < 1 ||
      (course.suggestedSemester as number) > 8 ||
      !Array.isArray(course.prerequisites) ||
      !course.prerequisites.every((id: unknown) => typeof id === 'string') ||
      ids.has(course.id as string)
    )
      return { ok: false, errorCode: 'INVALID_RESPONSE' };
    ids.add(course.id as string);
    semesters.set(course.id as string, course.suggestedSemester as number);
  }
  if (
    value.courses.some(
      (course: unknown) =>
        isRecord(course) && (course.prerequisites as string[]).some((id) => !ids.has(id) || id === course.id)
    )
  ) {
    return { ok: false, errorCode: 'INVALID_RESPONSE' };
  }
  if (
    value.warnings !== undefined &&
    (!Array.isArray(value.warnings) || !value.warnings.every((warning: unknown) => typeof warning === 'string'))
  ) {
    return { ok: false, errorCode: 'INVALID_RESPONSE' };
  }
  const sequences = value.recommendedSequences;
  if (
    sequences !== undefined &&
    (!Array.isArray(sequences) ||
      !sequences.every(
        (edge: unknown) =>
          isRecord(edge) &&
          typeof edge.from === 'string' &&
          typeof edge.to === 'string' &&
          ids.has(edge.from) &&
          ids.has(edge.to) &&
          edge.from !== edge.to &&
          (semesters.get(edge.from) ?? 0) < (semesters.get(edge.to) ?? 0) &&
          Number.isInteger(edge.page) &&
          (edge.page as number) > 0
      ))
  ) {
    return { ok: false, errorCode: 'INVALID_RESPONSE' };
  }
  return { ok: true, plan: value as CurriculumPlanPreview };
}

/** Derive stable storage metadata from a parsed plan without inventing a cohort or version. */
export function resolveCurriculumMetadata(plan: CurriculumPlanPreview): {
  major: string;
  cohort: string;
  version: string;
} {
  return {
    major: plan.major.trim(),
    cohort: /^20\d{2}$/.test(plan.grade.trim()) ? plan.grade.trim() : 'unspecified',
    version: plan.version?.trim() || 'auto',
  };
}

/** Parse the user's selected PDF without publishing rules or invoking a full-document model review. */
export async function previewCurriculumPlan(filePath: string): Promise<CurriculumPlanPreviewResponse> {
  const selectedPath = filePath.trim();
  if (!path.isAbsolute(selectedPath) || path.extname(selectedPath).toLowerCase() !== '.pdf') {
    return { ok: false, errorCode: 'INVALID_ATTACHMENT' };
  }
  try {
    return summarizeCurriculumPlanPreview(
      await invokeCourseTool('parse_program_plan', { filePath: selectedPath, includeFlow: true }, 45_000)
    );
  } catch (error) {
    return {
      ok: false,
      errorCode:
        error instanceof CourseServerNotConfigured ? 'COURSE_SERVER_NOT_CONFIGURED' : 'COURSE_SERVER_UNAVAILABLE',
    };
  }
}

export function summarizeCurriculumGraph(value: unknown): CurriculumGraphResponse {
  if (!isRecord(value)) return { ok: false, errorCode: 'INVALID_RESPONSE' };
  if (value.ok !== true) {
    const error = isRecord(value.error) ? value.error : {};
    const details = isRecord(error.details) ? error.details : {};
    return {
      ok: false,
      errorCode: field(error, 'code') ?? 'GRAPH_FAILED',
      processingStatus: field(details, 'processing_status'),
    };
  }
  const data = value.data;
  if (
    !isRecord(data) ||
    !field(data, 'document_id') ||
    !field(data, 'catalog_id') ||
    !field(data, 'document') ||
    !field(data, 'major') ||
    !field(data, 'cohort') ||
    !field(data, 'version') ||
    !(data.total_credits === null || typeof data.total_credits === 'number') ||
    !Array.isArray(data.courses) ||
    data.courses.length === 0
  ) {
    return { ok: false, errorCode: 'INVALID_RESPONSE' };
  }
  const coursesValid = data.courses.every(
    (course: unknown) =>
      isRecord(course) &&
      typeof course.id === 'string' &&
      typeof course.name === 'string' &&
      typeof course.credits === 'number' &&
      typeof course.category_label === 'string' &&
      typeof course.suggested_semester === 'number' &&
      Array.isArray(course.prerequisites) &&
      course.prerequisites.every((id: unknown) => typeof id === 'string') &&
      (course.page === null || typeof course.page === 'number') &&
      (course.section === null || typeof course.section === 'string')
  );
  if (!coursesValid) return { ok: false, errorCode: 'INVALID_RESPONSE' };
  return { ok: true, graph: data as CurriculumGraph };
}

/** Store the selected file; this never claims that its course graph is ready. */
export async function ingestCurriculumAttachment(request: CurriculumIngestRequest): Promise<CurriculumIngestResponse> {
  const attachmentPath = request.attachmentPath.trim();
  if (!path.isAbsolute(attachmentPath) || !ALLOWED_EXTENSIONS.has(path.extname(attachmentPath).toLowerCase())) {
    return { ok: false, errorCode: 'INVALID_ATTACHMENT' };
  }
  let preview: CurriculumPlanPreview | undefined;
  if (!request.major?.trim() || !request.cohort?.trim() || !request.version?.trim()) {
    const previewResult = await previewCurriculumPlan(attachmentPath);
    if (!previewResult.ok || !previewResult.plan) {
      return { ok: false, errorCode: previewResult.errorCode ?? 'PARSE_FAILED' };
    }
    preview = previewResult.plan;
  }
  const metadata = preview
    ? resolveCurriculumMetadata(preview)
    : {
        major: request.major?.trim() ?? '',
        cohort: request.cohort?.trim() ?? '',
        version: request.version?.trim() ?? '',
      };
  const { major, cohort, version } = metadata;
  if (!major || !cohort || !version) return { ok: false, errorCode: 'INVALID_ARGUMENT' };
  try {
    const result = summarizeCurriculumIngest(
      await invokeCourseTool(
        'curriculum_ingest_from_attachment',
        { attachment_path: attachmentPath, major, cohort, version },
        30_000
      )
    );
    return result.ok && preview ? { ...result, plan: preview } : result;
  } catch (error) {
    return {
      ok: false,
      errorCode:
        error instanceof CourseServerNotConfigured ? 'COURSE_SERVER_NOT_CONFIGURED' : 'COURSE_SERVER_UNAVAILABLE',
    };
  }
}

/** Load an existing verified graph, or explicitly try extraction once if it is not ready. */
export async function prepareCurriculumGraph(documentId: string): Promise<CurriculumGraphResponse> {
  if (!documentId.trim()) return { ok: false, errorCode: 'INVALID_ARGUMENT' };
  try {
    const first = summarizeCurriculumGraph(
      await invokeCourseTool('curriculum_graph', { document_id: documentId }, 20_000)
    );
    if (first.ok || first.errorCode !== 'CATALOG_NOT_READY') return first;
    const extraction: unknown = await invokeCourseTool(
      'retry_curriculum_extraction',
      { document_id: documentId },
      180_000
    );
    const extracted = summarizeExtractionOutcome(extraction);
    if (!extracted.ok) return extracted;
    return summarizeCurriculumGraph(await invokeCourseTool('curriculum_graph', { document_id: documentId }, 20_000));
  } catch (error) {
    return {
      ok: false,
      errorCode:
        error instanceof CourseServerNotConfigured ? 'COURSE_SERVER_NOT_CONFIGURED' : 'COURSE_SERVER_UNAVAILABLE',
    };
  }
}

/** Preserve the first real page failure; circuit-open skips are not separate model attempts. */
export function summarizeExtractionOutcome(value: unknown): CurriculumGraphResponse {
  if (!isRecord(value)) return { ok: false, errorCode: 'INVALID_RESPONSE' };
  if (value.ok !== true) {
    const error = isRecord(value.error) ? value.error : {};
    return { ok: false, errorCode: field(error, 'code') ?? 'EXTRACTION_FAILED' };
  }
  const data = isRecord(value.data) ? value.data : {};
  const document = isRecord(data.document) ? data.document : {};
  if (document.auto_verified === true) return { ok: true };
  const extraction = isRecord(data.extraction) ? data.extraction : {};
  const summary = isRecord(extraction.summary) ? extraction.summary : {};
  const failures = Array.isArray(summary.pages_failed) ? summary.pages_failed : [];
  const first = failures.find((item: unknown) => isRecord(item) && item.circuit_open !== true);
  const failure = isRecord(first) ? first : {};
  const extractionError = isRecord(extraction.error) ? extraction.error : {};
  const details = isRecord(extractionError.details) ? extractionError.details : {};
  return {
    ok: false,
    errorCode: 'CATALOG_NOT_READY',
    processingStatus: field(document, 'processing_status'),
    failedPage: typeof failure.page === 'number' ? failure.page : undefined,
    failureCode: field(failure, 'code') ?? field(extractionError, 'code'),
    failureStage: field(failure, 'stage') ?? field(details, 'stage'),
    failureReason: field(failure, 'reason') ?? field(details, 'reason'),
  };
}

function summarizeProbeMode(value: unknown): CurriculumProbeMode | null {
  if (!isRecord(value) || typeof value.reachable !== 'boolean' || typeof value.elapsed_ms !== 'number') return null;
  return {
    reachable: value.reachable,
    elapsedMs: value.elapsed_ms,
    errorCode: field(value, 'error_code'),
    reason: field(value, 'reason'),
  };
}

export function summarizeCurriculumProbe(value: unknown): CurriculumProbeResponse {
  if (!isRecord(value)) return { ok: false, errorCode: 'INVALID_RESPONSE' };
  if (value.ok !== true) {
    const error = isRecord(value.error) ? value.error : {};
    return { ok: false, errorCode: field(error, 'code') ?? 'PROBE_FAILED' };
  }
  const data = isRecord(value.data) ? value.data : {};
  const modes = isRecord(data.modes) ? data.modes : {};
  const nonStream = summarizeProbeMode(modes.non_stream);
  const stream = summarizeProbeMode(modes.stream);
  if (!field(data, 'document_id') || typeof data.page !== 'number' || !nonStream || !stream) {
    return { ok: false, errorCode: 'INVALID_RESPONSE' };
  }
  return {
    ok: true,
    documentId: field(data, 'document_id'),
    page: data.page,
    model: field(data, 'model'),
    inputCharacters: typeof data.input_characters === 'number' ? data.input_characters : undefined,
    nonStream,
    stream,
  };
}

export async function probeCurriculumPage(documentId: string, page: number): Promise<CurriculumProbeResponse> {
  if (!documentId.trim() || !Number.isInteger(page) || page < 1) return { ok: false, errorCode: 'INVALID_ARGUMENT' };
  try {
    const result = summarizeCurriculumProbe(
      await invokeCourseTool('curriculum_extraction_probe', { document_id: documentId, page }, 75_000)
    );
    return result.ok && (result.documentId !== documentId || result.page !== page)
      ? { ok: false, errorCode: 'DOCUMENT_MISMATCH' }
      : result;
  } catch (error) {
    return {
      ok: false,
      errorCode:
        error instanceof CourseServerNotConfigured ? 'COURSE_SERVER_NOT_CONFIGURED' : 'COURSE_SERVER_UNAVAILABLE',
    };
  }
}

export function summarizeCourseProgress(value: unknown): CurriculumProgressResponse {
  if (!isRecord(value)) return { ok: false, errorCode: 'INVALID_RESPONSE' };
  if (value.ok !== true) {
    const error = isRecord(value.error) ? value.error : {};
    return { ok: false, errorCode: field(error, 'code') ?? 'PROGRESS_FAILED' };
  }
  const data = isRecord(value.data) ? value.data : {};
  const statuses = isRecord(data.course_statuses) ? data.course_statuses : null;
  if (!statuses || !Object.values(statuses).every((status) => status === 'passed' || status === 'failed')) {
    return { ok: false, errorCode: 'INVALID_RESPONSE' };
  }
  return {
    ok: true,
    courseStatuses: statuses as Record<string, 'passed' | 'failed'>,
    updatedAt: field(data, 'updated_at'),
  };
}

export async function saveCourseProgress(request: CurriculumProgressRequest): Promise<CurriculumProgressResponse> {
  try {
    return summarizeCourseProgress(
      await invokeCourseTool(
        'save_course_progress',
        {
          profile_id: request.profileId,
          document_id: request.documentId,
          course_statuses: request.courseStatuses,
        },
        20_000
      )
    );
  } catch (error) {
    return {
      ok: false,
      errorCode:
        error instanceof CourseServerNotConfigured ? 'COURSE_SERVER_NOT_CONFIGURED' : 'COURSE_SERVER_UNAVAILABLE',
    };
  }
}

export async function loadCourseProgress(profileId: string, documentId: string): Promise<CurriculumProgressResponse> {
  try {
    return summarizeCourseProgress(
      await invokeCourseTool(
        'load_course_progress',
        {
          profile_id: profileId,
          document_id: documentId,
        },
        20_000
      )
    );
  } catch (error) {
    return {
      ok: false,
      errorCode:
        error instanceof CourseServerNotConfigured ? 'COURSE_SERVER_NOT_CONFIGURED' : 'COURSE_SERVER_UNAVAILABLE',
    };
  }
}

export function summarizeProgressClear(value: unknown): CurriculumProgressClearResponse {
  if (!isRecord(value)) return { ok: false, errorCode: 'INVALID_RESPONSE' };
  if (value.ok !== true) {
    const error = isRecord(value.error) ? value.error : {};
    return { ok: false, errorCode: field(error, 'code') ?? 'PROGRESS_CLEAR_FAILED' };
  }
  const data = isRecord(value.data) ? value.data : {};
  if (typeof data.removed !== 'boolean') return { ok: false, errorCode: 'INVALID_RESPONSE' };
  return { ok: true, removed: data.removed };
}

/** Clear only this device's anonymous progress for one curriculum. */
export async function clearCourseProgress(
  profileId: string,
  documentId: string
): Promise<CurriculumProgressClearResponse> {
  try {
    return summarizeProgressClear(
      await invokeCourseTool(
        'clear_course_progress',
        {
          profile_id: profileId,
          document_id: documentId,
          confirm: true,
        },
        20_000
      )
    );
  } catch (error) {
    return {
      ok: false,
      errorCode:
        error instanceof CourseServerNotConfigured ? 'COURSE_SERVER_NOT_CONFIGURED' : 'COURSE_SERVER_UNAVAILABLE',
    };
  }
}

function courseSummary(value: unknown): { courseCode: string; courseName: string } | null {
  if (!isRecord(value)) return null;
  const courseCode = field(value, 'course_code');
  const courseName = field(value, 'course_name');
  return courseCode && courseName ? { courseCode, courseName } : null;
}

/** Return only rules derived from the explicitly selected curriculum document. */
export function summarizeCoursePlan(value: unknown): CurriculumCoursePlanResponse {
  if (!isRecord(value)) return { ok: false, errorCode: 'INVALID_RESPONSE' };
  if (value.ok !== true) {
    const error = isRecord(value.error) ? value.error : {};
    return { ok: false, errorCode: field(error, 'code') ?? 'PLAN_FAILED' };
  }
  const data = isRecord(value.data) ? value.data : {};
  const documentId = field(data, 'document_id');
  const advice = isRecord(data.basic_advice) ? data.basic_advice : {};
  const status = field(advice, 'status');
  if (
    !documentId ||
    (status !== 'ELIGIBLE' && status !== 'NOT_ELIGIBLE') ||
    !Array.isArray(data.missing_courses) ||
    !Array.isArray(data.prerequisite_conflicts)
  ) {
    return { ok: false, errorCode: 'INVALID_RESPONSE' };
  }
  const missing = data.missing_courses;
  const conflicts = data.prerequisite_conflicts;
  const direct = conflicts.flatMap((item: unknown) =>
    isRecord(item) && Array.isArray(item.missing_direct_prerequisites) ? item.missing_direct_prerequisites : []
  );
  const missingCourses = missing.map(courseSummary);
  const missingDirectPrerequisites = direct.map(courseSummary);
  if (missingCourses.includes(null) || missingDirectPrerequisites.includes(null))
    return { ok: false, errorCode: 'INVALID_RESPONSE' };
  const sources = Array.isArray(value.sources) ? value.sources : [];
  const firstSource = isRecord(sources[0]) ? sources[0] : {};
  return {
    ok: true,
    documentId,
    status,
    missingCourses: missingCourses as { courseCode: string; courseName: string }[],
    missingDirectPrerequisites: missingDirectPrerequisites as { courseCode: string; courseName: string }[],
    source: {
      document: field(firstSource, 'document'),
      page: typeof firstSource.page === 'number' ? firstSource.page : null,
      section: field(firstSource, 'section') ?? null,
    },
    warnings: Array.isArray(value.warnings)
      ? value.warnings.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

export async function planCurriculumCourse(
  request: CurriculumCoursePlanRequest
): Promise<CurriculumCoursePlanResponse> {
  if (!request.documentId || !request.targetCourse || !request.major || !request.cohort) {
    return { ok: false, errorCode: 'INVALID_ARGUMENT' };
  }
  try {
    const response = summarizeCoursePlan(
      await invokeCourseTool(
        'course_path_plan',
        {
          document_id: request.documentId,
          major: request.major,
          grade: request.cohort,
          target_course: request.targetCourse,
          completed_courses: request.completedCourses,
        },
        20_000
      )
    );
    return response.ok && response.documentId !== request.documentId
      ? { ok: false, errorCode: 'DOCUMENT_MISMATCH' }
      : response;
  } catch (error) {
    return {
      ok: false,
      errorCode:
        error instanceof CourseServerNotConfigured ? 'COURSE_SERVER_NOT_CONFIGURED' : 'COURSE_SERVER_UNAVAILABLE',
    };
  }
}
