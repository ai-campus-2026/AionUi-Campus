// ============================================================
// 政策解读工作台 · 状态层
// 聊天与政策解读走真实 AI/MCP 管线（modelClient + 对话数据库）；
// 「我的报告 / 我的信息」仍为本地 localStorage 数据。
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TProviderWithModel } from '@/common/config/storage';
import type { CampusRuleToolResult } from '@renderer/components/campus-rule/types';
import { engineGroupsToMcp, groupsFromMcp, summaryFromGroups } from './model';
import type { AnalysisTask, Conversation, ProfileField, ReportSnapshot, ViewName, WorkbenchState } from './model';
import {
  createSeedState,
  detectGoal,
  dynamicFieldKey,
  fieldLabel,
  findPolicy,
  goalPolicyPrefix,
  guessFieldKey,
  makeId,
  matchConditions,
  todayStr,
  type GoalDef,
  GOALS,
} from './engine';
import {
  ensureConversation,
  getConvId,
  loadLatestRuleResult,
  removeConvId,
  sendToConversation,
  setConvId,
  subscribeStream,
  taskIdOfConv,
} from './modelClient';
import { loadLatestConversationMessages } from '@renderer/utils/chat/messagePagination';
import { useGuidAssistantSelection } from '@renderer/pages/guid/hooks/useGuidAssistantSelection';
import { useGuidModelSelection } from '@renderer/pages/guid/hooks/useGuidModelSelection';

const STORAGE_KEY = 'campus-rule-workbench:v1';

/**
 * 入口页（提问入口）的自由对话会话 id —— 不绑定任何分析任务。
 * 复用与任务会话完全相同的真实 AI 管线（ensureConversation / sendToAi /
 * 流式订阅），只是 taskId 用这个保留值，使「无分析状态」下也能与 AI 对话。
 */
export const ENTRY_TASK_ID = '__entry__';

function loadState(): WorkbenchState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as WorkbenchState;
      if (parsed && parsed.profile && Array.isArray(parsed.tasks) && Array.isArray(parsed.reports)) {
        return parsed;
      }
    }
  } catch {
    // 解析失败则回退种子数据
  }
  return createSeedState();
}

function saveState(state: WorkbenchState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存储不可用时静默降级（内存态仍可用）
  }
}

export interface UiState {
  view: ViewName;
  viewingReportId: string | null;
  /** 当前解读视图（view === 'analysis'）展示的会话任务 id（ENTRY_TASK_ID 或历史任务） */
  interpretTaskId: string | null;
  /** 各任务的 AI 回复中（key = taskId，用于聊天列的输入中指示） */
  aiBusy: Record<string, boolean>;
}

/**
 * 一次真实 MCP 政策解读渲染所需的数据：
 * result 来自 policy.query_policy / rag search / campus_rule 工具输出，
 * 经 tryParseCampusRuleResult 解析（与对话页 MessageToolGroupSummary 同一链路）。
 */
export interface RuleResultData {
  result: CampusRuleToolResult;
  question?: string;
  /** 产生该结果的工具消息 id（用于判断结果是否更新，避免重复切换视图） */
  messageId?: string;
  updatedAt: string;
}

const initialUi = (_state: WorkbenchState): UiState => ({
  // 进入政策解读默认停在「提问入口」：不自动恢复任何分析任务
  view: 'entry',
  viewingReportId: null,
  interpretTaskId: null,
  aiBusy: {},
});

export interface WorkbenchApi {
  state: WorkbenchState;
  ui: UiState;
  /** 入口页自由对话（不绑定分析任务；taskId = ENTRY_TASK_ID） */
  entryConversation: Conversation | undefined;
  /** 当前解读视图对应的对话（interpretTaskId） */
  interpretConversation: Conversation | undefined;
  goalDefs: GoalDef[];
  switchView: (v: ViewName) => void;
  /**
   * 聊天框发送：全部走真实 AI 管线（ensureConversation + 流式订阅）。
   * 回复结束后若本轮产生了可解析的 MCP 政策解读工具结果，自动切换到解读视图。
   */
  sendEntryMessage: (text: string) => void;
  /** 解读视图内继续追问（同一真实会话；新结果到达后自动刷新解读） */
  sendInterpretMessage: (text: string) => void;
  /** 各任务的 AI 回复中（key = taskId） */
  aiBusy: UiState['aiBusy'];
  /** 已加载的真实 MCP 政策解读结果（key = taskId；ENTRY_TASK_ID 为入口自由对话） */
  ruleResults: Record<string, RuleResultData>;
  /** 用户当前选中的 assistant id（与首页一致） */
  selectedAssistantId: string | null;
  /** 用户当前选中的模型（aionrs） */
  currentModel: TProviderWithModel | undefined;
  /** 从对话数据库加载最新 MCP 工具结果并刷新解读视图 */
  refreshRuleResult: (taskId: string, convId: string, forceView?: boolean, forceUpdate?: boolean) => Promise<void>;
  /** 打开某任务的解读视图（快捷入口 / 最近分析 / 我的报告「继续完善」） */
  openInterpret: (taskId: string) => void;
  /** 快捷入口 / 最近分析：以真实问题发起 AI 对话（不再创建 mock 任务） */
  askGoal: (goalKey: string) => void;
  viewReport: (reportId: string) => void;
  openReportOfTask: (taskId: string) => void;
  updateProfileField: (key: string, value: string) => void;
  /** 按标题创建新分析任务（调试注入用），返回 taskId */
  createTask: (title: string) => string;
  /** 旧报告 + 政策已更新 → 基于最新政策重新匹配并生成新快照（报告页保留能力） */
  reanalyzeWithLatestPolicy: (taskId: string) => void;
  resetDemo: () => void;
  /** 调试：手动注入一条 MCP 结果 JSON，模拟真实返回（Ctrl+Shift+D 触发） */
  debugInjectResult: (
    taskId: string,
    result: import('@renderer/components/campus-rule/types').CampusRuleToolResult,
    question?: string
  ) => void;
  /** 删除单个分析任务（同时删除其所有报告快照和对话记录） */
  deleteTask: (taskId: string) => void;
  /** 批量删除多个分析任务 */
  deleteTasks: (taskIds: string[]) => void;
}

export function useWorkbench(): WorkbenchApi {
  const [state, setState] = useState<WorkbenchState>(loadState);
  const [ui, setUi] = useState<UiState>(() => initialUi(loadState()));

  // 持久化（仅数据层，UI 状态不入库）
  useEffect(() => {
    saveState(state);
  }, [state]);

  const stateRef = useRef(state);
  stateRef.current = state;
  const uiRef = useRef(ui);
  uiRef.current = ui;

  /* ---- 与首页一致：使用用户当前选中的 assistant 和模型 ---- */
  const agentSelection = useGuidAssistantSelection({});
  const modelSelection = useGuidModelSelection('aionrs');
  const selectedAssistantRef = useRef<{ id: string | null; backend: string }>({ id: null, backend: '' });
  selectedAssistantRef.current = {
    id: agentSelection.selectedAssistantId,
    backend: agentSelection.selectedAssistantBackend,
  };
  const selectedModelRef = useRef(modelSelection.current_model);
  selectedModelRef.current = modelSelection.current_model;

  /* ---- AI 回复超时保护：空闲超时（20s 无新文本块）+ 硬性超时（180s） ---- */
  const idleTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const hardTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearAiTimers = useCallback((taskId: string) => {
    const idle = idleTimersRef.current.get(taskId);
    if (idle) {
      clearTimeout(idle);
      idleTimersRef.current.delete(taskId);
    }
    const hard = hardTimersRef.current.get(taskId);
    if (hard) {
      clearTimeout(hard);
      hardTimersRef.current.delete(taskId);
    }
  }, []);

  const resetIdleTimer = useCallback((taskId: string) => {
    const existing = idleTimersRef.current.get(taskId);
    if (existing) clearTimeout(existing);
    // 20 秒无新文本块则认为回复结束（finish 事件可能丢失）
    const timer = setTimeout(() => {
      idleTimersRef.current.delete(taskId);
      setUi((u) => ({ ...u, aiBusy: { ...u.aiBusy, [taskId]: false } }));
    }, 20000);
    idleTimersRef.current.set(taskId, timer);
  }, []);

  /** 入口页自由对话（不绑定分析任务） */
  const entryConversation = useMemo(
    () => state.conversations.find((c) => c.taskId === ENTRY_TASK_ID),
    [state.conversations]
  );

  /** 当前解读视图对应的对话（可能是入口会话，也可能是历史任务会话） */
  const interpretConversation = useMemo(
    () => (ui.interpretTaskId ? state.conversations.find((c) => c.taskId === ui.interpretTaskId) : undefined),
    [state.conversations, ui.interpretTaskId]
  );

  /* ---- 真实 MCP 政策解读结果（key = taskId） ---- */
  const [ruleResults, setRuleResults] = useState<Record<string, RuleResultData>>({});
  const ruleResultsRef = useRef(ruleResults);
  const pushReportRef = useRef<typeof pushReport | null>(null);
  ruleResultsRef.current = ruleResults;

  const switchView = useCallback((v: ViewName) => {
    setUi((u) => ({ ...u, view: v }));
  }, []);

  /**
   * 从对话数据库加载某会话最近一条可解析的政策解读工具结果；
   * 有新结果（messageId 变化）时写入 ruleResults 并切换到解读视图。
   */
  const refreshRuleResult = useCallback(
    async (taskId: string, convId: string, forceView = false, forceUpdate = false) => {
      const loaded = await loadLatestRuleResult(convId);
      if (!loaded) return;

      // ===== ENTRY 页新结果 → 自动创建或恢复分析任务 =====
      let actualTaskId = taskId;
      let activeTask: AnalysisTask | null = null;
      if (taskId === ENTRY_TASK_ID) {
        const groups = groupsFromMcp(loaded.result);
        if (groups.length > 0) {
          const goal = detectGoal(loaded.question ?? '');
          // 从 MCP 结果推导政策文件标识：优先 policyVersionId，其次 policyHits[0].source，最后默认
          const mcpPolicyId = loaded.result?.policyVersionId ?? loaded.result?.policyHits?.[0]?.source ?? 'pv-default';
          const goalKey = goal?.goalKey ?? `dynamic_${makeId('dyn')}`;
          // 任务匹配：goalKey + policyVersionId（同一资格类别 + 同一查询文件才归为同一任务）
          const existingTask = stateRef.current.tasks.find(
            (t) => t.goalKey === goalKey && t.policyVersionId === mcpPolicyId
          );

          if (existingTask) {
            actualTaskId = existingTask.id;
            activeTask = existingTask;
          } else {
            const title = goal?.title ?? loaded.question ?? '政策资格分析';
            const policyVersionId = mcpPolicyId;
            const newTask: AnalysisTask = {
              id: makeId('task'),
              goalKey,
              title,
              policyVersionId,
              createdAt: todayStr(),
              updatedAt: todayStr(),
              current: [],
            };
            setState((s) => ({ ...s, tasks: [...s.tasks, newTask] }));
            actualTaskId = newTask.id;
            activeTask = newTask;

            const entryConvId = getConvId(ENTRY_TASK_ID);
            if (entryConvId) {
              setConvId(newTask.id, entryConvId);
              removeConvId(ENTRY_TASK_ID);
            }
          }
        }
      }

      const prev = ruleResultsRef.current[actualTaskId];
      const isNew = forceUpdate || !prev || prev.messageId !== loaded.messageId;
      if (isNew) {
        const next: Record<string, RuleResultData> = { ...ruleResultsRef.current };
        next[actualTaskId] = {
          result: loaded.result,
          question: loaded.question,
          messageId: loaded.messageId,
          updatedAt: todayStr(),
        };
        // 从 ENTRY 迁移后，清除 ENTRY 下的旧结果
        if (actualTaskId !== taskId) delete next[taskId];
        ruleResultsRef.current = next;
        setRuleResults(next);

        // ===== 从 MCP 结果自动同步「我的信息」 =====
        // 遍历条件行，提取 userValue 非空的项，推断字段 key 后更新个人资料
        const mcpGroups = groupsFromMcp(loaded.result);
        const updatedFields: { key: string; label: string; value: string }[] = [];
        for (const g of mcpGroups) {
          for (const row of g.rows) {
            const val = row.userValue?.trim();
            if (!val || val === '未提供' || val === '-' || val === '—') continue;
            // 优先用预设字段映射，不在映射里的条件自动生成动态 fieldKey
            let fieldKey = guessFieldKey(row.item);
            let fieldLabelStr: string;
            if (!fieldKey) {
              fieldKey = dynamicFieldKey(row.item);
              fieldLabelStr = row.item; // 动态字段用条件名称作为标签
            } else {
              fieldLabelStr = fieldLabel(fieldKey);
            }
            const prevField = stateRef.current.profile.fields[fieldKey];
            if (prevField?.value === val) continue; // 值未变，不重复更新
            updatedFields.push({ key: fieldKey, label: fieldLabelStr, value: val });
          }
        }
        if (updatedFields.length > 0) {
          const now = todayStr();
          setState((s) => {
            const fields = { ...s.profile.fields };
            for (const uf of updatedFields) {
              const existing = fields[uf.key];
              fields[uf.key] = {
                key: uf.key,
                label: existing?.label ?? uf.label,
                category: existing?.category ?? 'other',
                value: uf.value,
                updatedAt: now,
              };
            }
            return { ...s, profile: { ...s.profile, fields, updatedAt: now } };
          });
        }

        // MCP 新结果到达 → 更新任务当前结果 + 生成报告快照
        if (actualTaskId !== ENTRY_TASK_ID) {
          const task = activeTask ?? stateRef.current.tasks.find((t) => t.id === actualTaskId);
          if (task) {
            const groups = groupsFromMcp(loaded.result);
            if (groups.length > 0) {
              const summary = summaryFromGroups(groups);
              // 更新任务当前结果
              setState((s) => ({
                ...s,
                tasks: s.tasks.map((t) =>
                  t.id === actualTaskId ? { ...t, current: groups, updatedAt: todayStr() } : t
                ),
              }));
              // 生成报告快照
              const prevReport = stateRef.current.reports
                .filter((r) => r.analysisTaskId === actualTaskId)
                .sort((a, b) => b.version - a.version)[0];
              const changes: ReportSnapshot['changes'] = [];
              if (prevReport) {
                const diff = summary.met - prevReport.summary.met;
                const diffMissing = summary.missing + summary.review - prevReport.summary.missing;
                if (diff !== 0)
                  changes.push({ label: '结果变化', text: `${prevReport.summary.met} 项满足 → ${summary.met} 项满足` });
                if (diffMissing !== 0)
                  changes.push({
                    label: '待确认变化',
                    text: `${prevReport.summary.missing} 项待确认 → ${summary.missing + summary.review} 项待确认`,
                  });
              } else {
                changes.push({
                  label: '首次分析',
                  text: `完成首次政策匹配：${summary.met} 项满足 · ${summary.missing + summary.review} 项待确认 · ${summary.notMet} 项未满足`,
                });
              }
              pushReportRef.current?.(
                { ...task, current: groups, updatedAt: todayStr() },
                {
                  groups,
                  summary: { met: summary.met, missing: summary.missing + summary.review, notMet: summary.notMet },
                },
                task.policyVersionId,
                changes
              );
            }
          }
        }
      }
      if (isNew || forceView) {
        const view = uiRef.current.view;
        if (forceView || view === 'entry' || view === 'analysis') {
          setUi((u) => ({ ...u, view: 'analysis', interpretTaskId: actualTaskId }));
        }
      }
    },
    []
  );

  /** 打开某任务的解读视图（快捷入口 / 最近分析 / 我的报告「继续完善」） */
  const openInterpret = useCallback(
    (taskId: string) => {
      setUi((u) => ({ ...u, view: 'analysis', interpretTaskId: taskId }));
      // 种子 mock 任务（task-scholar / task-tuimian）没有真实对话，不去后端拉数据，避免 mock 被覆盖
      const SEED_TASK_IDS = ['task-scholar', 'task-tuimian'];
      if (SEED_TASK_IDS.includes(taskId)) return;
      const convId = getConvId(taskId);
      if (convId && !ruleResultsRef.current[taskId]) {
        void refreshRuleResult(taskId, convId);
      }
    },
    [refreshRuleResult]
  );

  /** 追加对话消息（自动去重/限制长度）；会话不存在时自动创建（入口自由对话用） */
  const pushMessage = useCallback((taskId: string, msg: Omit<Conversation['messages'][number], 'id' | 'createdAt'>) => {
    const full = { ...msg, id: makeId('msg'), createdAt: todayStr() };
    setState((s) => {
      const exists = s.conversations.some((c) => c.taskId === taskId);
      const conversations = exists
        ? s.conversations.map((c) => (c.taskId === taskId ? { ...c, messages: [...c.messages, full].slice(-40) } : c))
        : [...s.conversations, { id: makeId('conv'), taskId, messages: [full] }];
      return { ...s, conversations };
    });
  }, []);

  /* ---- 数据库兜底轮询：不依赖流式事件，直接从对话数据库拉取最新回复 ---- */
  const pollTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastPolledTextRef = useRef<Map<string, string>>(new Map());
  const stableCountRef = useRef<Map<string, number>>(new Map());
  const prevAssistantMsgIdRef = useRef<Map<string, string>>(new Map());

  const stopPolling = useCallback((taskId: string) => {
    const t = pollTimersRef.current.get(taskId);
    if (t) {
      clearTimeout(t);
      pollTimersRef.current.delete(taskId);
    }
    stableCountRef.current.delete(taskId);
  }, []);

  const pollDbForReply = useCallback(
    async (taskId: string, convId: string) => {
      try {
        const page = await loadLatestConversationMessages(convId, { limit: 30, contentMode: 'full' });
        const msgs = page.items ?? [];
        const prevId = prevAssistantMsgIdRef.current.get(taskId) ?? '';

        // 从最新往回找：跳过旧的 assistant 消息（msg_id 等于发送前记录的）
        let assistantText = '';
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m.type === 'text' && m.position === 'left' && !m.hidden) {
            if (m.msg_id && m.msg_id === prevId) continue; // 上一轮的旧消息
            const text =
              typeof (m.content as { content?: string } | undefined)?.content === 'string'
                ? (m.content as { content: string }).content
                : '';
            if (text.trim()) {
              assistantText = text;
              break;
            }
          }
        }

        if (assistantText) {
          const last = lastPolledTextRef.current.get(taskId) ?? '';
          if (assistantText !== last) {
            // 新文本：显示（流式可能已显示过，但数据库兜底确保不丢）
            lastPolledTextRef.current.set(taskId, assistantText);
            stableCountRef.current.set(taskId, 0);
            pushMessage(taskId, { kind: 'assistant', text: assistantText });
          } else {
            // 文本连续两次轮询不变 → 认为回复结束
            const stable = (stableCountRef.current.get(taskId) ?? 0) + 1;
            stableCountRef.current.set(taskId, stable);
            if (stable >= 2) {
              stopPolling(taskId);
              clearAiTimers(taskId);
              setUi((u) => ({ ...u, aiBusy: { ...u.aiBusy, [taskId]: false } }));
              void refreshRuleResult(taskId, convId);
              return; // 不再调度下一次轮询
            }
          }
        }
      } catch {
        // 轮询失败静默，下一次继续
      }
      // 调度下一次轮询（4 秒间隔）
      const t = setTimeout(() => void pollDbForReply(taskId, convId), 4000);
      pollTimersRef.current.set(taskId, t);
    },
    [pushMessage, refreshRuleResult, stopPolling, clearAiTimers]
  );

  /* ---- AI 对话：流式订阅（应用生命周期内单例） ---- */
  useEffect(() => {
    return subscribeStream({
      onText: (convId, text) => {
        const taskId = taskIdOfConv(convId);
        if (taskId) {
          pushMessage(taskId, { kind: 'assistant', text });
          lastPolledTextRef.current.set(taskId, text); // 同步给数据库轮询去重
          resetIdleTimer(taskId); // 收到新文本块，重置空闲超时
        }
      },
      onDone: (convId) => {
        const taskId = taskIdOfConv(convId);
        if (!taskId) return;
        stopPolling(taskId);
        clearAiTimers(taskId);
        setUi((u) => ({ ...u, aiBusy: { ...u.aiBusy, [taskId]: false } }));
        // 本轮结束后从对话数据库加载 MCP 工具结果；有新解读结果则自动切到解读视图
        void refreshRuleResult(taskId, convId);
      },
      onError: (convId, message) => {
        const taskId = taskIdOfConv(convId);
        if (taskId) {
          stopPolling(taskId);
          clearAiTimers(taskId);
          pushMessage(taskId, { kind: 'assistant', text: `（AI 回复失败）${message}` });
          setUi((u) => ({ ...u, aiBusy: { ...u.aiBusy, [taskId]: false } }));
        }
      },
    });
  }, [pushMessage, refreshRuleResult, resetIdleTimer, clearAiTimers, stopPolling]);

  /** 向任务的真实 AI 对话发送一条消息；失败返回具体错误（调用方负责可见提示） */
  const sendToAi = useCallback(
    async (
      taskId: string,
      text: string,
      name: string
    ): Promise<{ ok: boolean; error?: string; isConflict?: boolean }> => {
      if (!taskId) return { ok: false, error: '当前没有分析任务' };
      clearAiTimers(taskId);
      setUi((u) => ({ ...u, aiBusy: { ...u.aiBusy, [taskId]: true } }));

      // 与首页一致：aionrs 用当前选中模型，acp 不传 model（模型在 assistant 配置里）
      const { id: assistantId, backend } = selectedAssistantRef.current;
      const model = backend === 'aionrs' ? selectedModelRef.current : undefined;
      const conv = await ensureConversation(taskId, name, { assistantId, model });

      if ('error' in conv) {
        clearAiTimers(taskId);
        setUi((u) => ({ ...u, aiBusy: { ...u.aiBusy, [taskId]: false } }));
        return { ok: false, error: conv.error };
      }
      const res = await sendToConversation(conv.id, text);
      if (!res.ok) {
        // 409：后端会话还在运行中，前端保持 aiBusy=true（禁用发送），等待上一轮结束
        if (!res.isConflict) {
          clearAiTimers(taskId);
          setUi((u) => ({ ...u, aiBusy: { ...u.aiBusy, [taskId]: false } }));
        }
        return res;
      }
      // 发送成功：启动空闲超时（20s 无新文本块则自动结束）和硬性超时（180s）
      resetIdleTimer(taskId);
      const hardTimer = setTimeout(() => {
        hardTimersRef.current.delete(taskId);
        clearAiTimers(taskId);
        stopPolling(taskId);
        setUi((u) => ({ ...u, aiBusy: { ...u.aiBusy, [taskId]: false } }));
        pushMessage(taskId, {
          kind: 'system_info',
          text: 'AI 回复超时，可能是模型或工具调用较慢。你可以重新发送，或刷新页面后重试。',
        });
      }, 180000);
      hardTimersRef.current.set(taskId, hardTimer);

      // 数据库兜底轮询：记录发送前最后一条 assistant 消息 id，轮询时跳过旧消息
      stopPolling(taskId);
      lastPolledTextRef.current.delete(taskId);
      stableCountRef.current.delete(taskId);
      loadLatestConversationMessages(conv.id, { limit: 10, contentMode: 'compact' })
        .then((p) => {
          const prev = [...(p.items ?? [])].reverse().find((m) => m.type === 'text' && m.position === 'left');
          prevAssistantMsgIdRef.current.set(taskId, prev?.msg_id ?? '');
        })
        .catch(() => {
          prevAssistantMsgIdRef.current.set(taskId, '');
        });
      // 3 秒后开始轮询（给流式一点时间，流式正常则轮询只做结束检测）
      const pollTimer = setTimeout(() => void pollDbForReply(taskId, conv.id), 3000);
      pollTimersRef.current.set(taskId, pollTimer);

      return res;
    },
    [clearAiTimers, resetIdleTimer, pushMessage]
  );

  /** AI 发送失败的可见提示（不静默吞掉） */
  const aiFail = useCallback(
    (taskId: string, error?: string) => {
      if (!taskId) return;
      pushMessage(taskId, {
        kind: 'system_info',
        text: `AI 暂时无法回复${error ? `：${error}` : ''}。你可以稍后再试。`,
      });
    },
    [pushMessage]
  );

  /** 生成新报告快照（V 递增，不可变追加） */
  const pushReport = useCallback(
    (
      task: AnalysisTask,
      outcome: { groups: AnalysisTask['current']; summary: ReportSnapshot['summary'] },
      policyId: string,
      changes: ReportSnapshot['changes']
    ): ReportSnapshot => {
      const pv = findPolicy(stateRef.current, policyId);
      const version = stateRef.current.reports.filter((r) => r.analysisTaskId === task.id).length + 1;
      const profile = stateRef.current.profile;
      const snapshot = Object.values(profile.fields)
        .filter((f) => f.value !== '未提供')
        .map((f) => ({ label: f.label, value: f.value }));
      const report: ReportSnapshot = {
        id: makeId('report'),
        version,
        createdAt: todayStr(),
        analysisTaskId: task.id,
        profileSnapshot: snapshot,
        policyVersion: pv ?? { id: policyId, title: '未知政策文件', version: '—', publishedAt: '', latest: false },
        matchResults: outcome.groups,
        summary: outcome.summary,
        changes,
      };
      setState((s) => ({ ...s, reports: [...s.reports, report] }));
      return report;
    },
    []
  );
  pushReportRef.current = pushReport;

  /** 重建某任务的最新匹配 + 更新任务 */
  const rerunTask = useCallback((taskId: string, policyId?: string) => {
    const s = stateRef.current;
    const task = s.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    const def = GOALS.find((g) => g.goalKey === task.goalKey);
    if (!def) return null;
    const outcome = matchConditions(s.profile, def.conditions);
    const mcpGroups = engineGroupsToMcp(outcome.groups);
    const nextPolicyId = policyId ?? task.policyVersionId;
    setState((st) => ({
      ...st,
      tasks: st.tasks.map((t) =>
        t.id === taskId ? { ...t, current: mcpGroups, updatedAt: todayStr(), policyVersionId: nextPolicyId } : t
      ),
    }));
    return {
      task: { ...task, current: mcpGroups, updatedAt: todayStr(), policyVersionId: nextPolicyId },
      outcome: { ...outcome, groups: mcpGroups },
    };
  }, []);

  /**
   * 聊天框发送（入口页 / 解读视图共用）：
   * 全部走真实 AI 管线（ensureConversation + 流式订阅）；
   * 回复结束后由流式订阅的 onDone 加载 MCP 工具结果，
   * 若产生可解析的政策解读结果则自动切换到解读视图（AnswerTemplate 渲染）。
   */
  const sendEntryMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      pushMessage(ENTRY_TASK_ID, { kind: 'user', text: trimmed });
      void sendToAi(ENTRY_TASK_ID, trimmed, '政策解读助手').then((r) => {
        if (!r.ok) {
          if (r.isConflict) {
            pushMessage(ENTRY_TASK_ID, {
              kind: 'system_info',
              text: '上一轮还在处理中，请稍等片刻再发送。',
            });
          } else {
            aiFail(ENTRY_TASK_ID, r.error);
          }
        }
      });
    },
    [pushMessage, sendToAi, aiFail]
  );

  /** 解读视图内继续追问：沿用当前解读会话（入口会话或历史任务会话） */
  const sendInterpretMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const taskId = uiRef.current.interpretTaskId ?? ENTRY_TASK_ID;
      const task = stateRef.current.tasks.find((t) => t.id === taskId);
      pushMessage(taskId, { kind: 'user', text: trimmed });
      void sendToAi(taskId, trimmed, task?.title ?? '政策解读助手').then((r) => {
        if (!r.ok) {
          if (r.isConflict) {
            pushMessage(taskId, {
              kind: 'system_info',
              text: '上一轮还在处理中，请稍等片刻再发送。',
            });
          } else {
            aiFail(taskId, r.error);
          }
        }
      });
    },
    [pushMessage, sendToAi, aiFail]
  );

  /** 快捷入口 / 最近分析：以真实问题发起 AI 对话（不再创建 mock 任务） */
  const askGoal = useCallback(
    (goalKey: string) => {
      const def = GOALS.find((g) => g.goalKey === goalKey);
      if (!def) return;
      sendEntryMessage(`我想了解${def.title}的申请条件，请帮我解读`);
    },
    [sendEntryMessage]
  );

  const viewReport = useCallback((reportId: string) => {
    setUi((u) => ({ ...u, view: 'report', viewingReportId: reportId }));
  }, []);

  const openReportOfTask = useCallback(
    (taskId: string) => {
      const s = stateRef.current;
      const latest = s.reports.filter((r) => r.analysisTaskId === taskId).toSorted((a, b) => b.version - a.version)[0];
      if (latest) {
        setUi((u) => ({ ...u, view: 'report', viewingReportId: latest.id }));
      } else {
        openInterpret(taskId);
      }
    },
    [openInterpret]
  );

  /** 旧报告 + 政策已更新 → 基于最新政策重新匹配并生成新快照（旧报告不变） */
  const reanalyzeWithLatestPolicy = useCallback(
    (taskId: string) => {
      const s = stateRef.current;
      const task = s.tasks.find((t) => t.id === taskId);
      if (!task) return;
      const def = GOALS.find((g) => g.goalKey === task.goalKey);
      const prefix = def ? goalPolicyPrefix(def.goalKey) : '';
      const latestPv =
        s.policyVersions.find((p) => p.latest && p.id.startsWith(prefix)) ?? s.policyVersions.find((p) => p.latest);
      const beforeSummary = (() => {
        const sum = { met: 0, missing: 0, notMet: 0 };
        task.current.forEach((g) =>
          g.rows.forEach((r) => {
            sum[r.match === 'met' ? 'met' : r.match === 'not_met' ? 'notMet' : 'missing'] += 1;
          })
        );
        return sum;
      })();
      const rerun = rerunTask(taskId, latestPv?.id);
      if (!rerun) return;
      const { task: nextTask, outcome } = rerun;
      const changes: ReportSnapshot['changes'] = [
        { label: '政策版本', text: latestPv ? `基于最新政策《${latestPv.version}》重新匹配` : '' },
        { label: '结果变化', text: `${beforeSummary.met} 项满足 → ${outcome.summary.met} 项满足` },
      ].filter((c) => c.text !== '');
      pushReport(nextTask, outcome, nextTask.policyVersionId, changes);
    },
    [pushReport, rerunTask]
  );

  /** 「我的信息」页直接编辑字段 */
  const updateProfileField = useCallback((key: string, value: string) => {
    const now = todayStr();
    setState((s) => {
      const prev = s.profile.fields[key];
      const updated: ProfileField = {
        key,
        label: prev?.label ?? fieldLabel(key),
        category: prev?.category ?? 'other',
        value: value.trim() === '' ? '未提供' : value.trim(),
        updatedAt: now,
      };
      return { ...s, profile: { ...s.profile, updatedAt: now, fields: { ...s.profile.fields, [key]: updated } } };
    });
  }, []);

  /** 按标题创建新分析任务（调试注入用），已存在同名任务则返回已有 id */
  const createTask = useCallback((title: string): string => {
    const existing = stateRef.current.tasks.find((t) => t.title === title);
    if (existing) return existing.id;
    const newTask: AnalysisTask = {
      id: makeId('task'),
      goalKey: `debug_${makeId('dbg')}`,
      title,
      policyVersionId: 'pv-debug',
      createdAt: todayStr(),
      updatedAt: todayStr(),
      current: [],
    };
    // 同步更新 stateRef，确保紧接着调用的 debugInjectResult 能找到新 task
    stateRef.current = { ...stateRef.current, tasks: [...stateRef.current.tasks, newTask] };
    setState((s) => ({ ...s, tasks: [...s.tasks, newTask] }));
    return newTask.id;
  }, []);

  const resetDemo = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    const fresh = createSeedState();
    setState(fresh);
    setUi(initialUi(fresh));
    ruleResultsRef.current = {};
    setRuleResults({});
  }, []);

  /** 调试：手动注入 MCP 结果，走和真实返回完全一样的渲染+报告生成路径 */
  const debugInjectResult = useCallback(
    (
      taskId: string,
      result: import('@renderer/components/campus-rule/types').CampusRuleToolResult,
      question?: string
    ) => {
      const groups = groupsFromMcp(result);
      if (groups.length === 0) {
        console.warn('[debugInject] 解析后无分组，检查 JSON 结构是否包含 conditionGroups 或 conditionTable');
      }
      const msgId = `debug_${Date.now()}`;
      const next: Record<string, RuleResultData> = { ...ruleResultsRef.current };
      next[taskId] = { result, question: question ?? '调试注入', messageId: msgId, updatedAt: todayStr() };
      ruleResultsRef.current = next;
      setRuleResults(next);

      // 更新任务 current + 生成报告
      const task = stateRef.current.tasks.find((t) => t.id === taskId);
      if (task && groups.length > 0) {
        const summary = summaryFromGroups(groups);
        // 如果 MCP 结果里有 policyFileName / policyVersionId，自动创建 PolicyVersion 记录
        const mcpPvId = result.policyVersionId ?? task.policyVersionId;
        let existingPv = stateRef.current.policyVersions.find((p) => p.id === mcpPvId);
        if (!existingPv && result.policyFileName) {
          // 从 policyFileName 解析标题和版本，如 "《优秀毕业生评选办法》2026版"
          const fn = result.policyFileName;
          const titleMatch = fn.match(/[《](.+?)[》]/);
          const versionMatch = fn.match(/(\d{4}[版年]|第[一二三四五六七八九十]+版)/);
          const newPv = {
            id: mcpPvId,
            title: titleMatch ? titleMatch[1] : fn,
            version: versionMatch ? versionMatch[0] : '—',
            publishedAt: todayStr(),
            latest: true,
          };
          // 同步更新 stateRef，确保紧接着的 pushReport 能找到这个 PV
          stateRef.current = { ...stateRef.current, policyVersions: [...stateRef.current.policyVersions, newPv] };
          setState((s) => ({ ...s, policyVersions: [...s.policyVersions, newPv] }));
          existingPv = newPv;
        }
        // 确保 task.policyVersionId 与 MCP 结果一致（同步更新 stateRef）
        let updatedTask = task;
        if (task.policyVersionId !== mcpPvId) {
          updatedTask = { ...task, policyVersionId: mcpPvId };
          stateRef.current = {
            ...stateRef.current,
            tasks: stateRef.current.tasks.map((t) => (t.id === taskId ? { ...t, policyVersionId: mcpPvId } : t)),
          };
          setState((s) => ({
            ...s,
            tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, policyVersionId: mcpPvId } : t)),
          }));
        }
        // 更新 task.current（同步更新 stateRef）
        const taskWithCurrent = { ...updatedTask, current: groups, updatedAt: todayStr() };
        stateRef.current = {
          ...stateRef.current,
          tasks: stateRef.current.tasks.map((t) =>
            t.id === taskId ? { ...t, current: groups, updatedAt: todayStr() } : t
          ),
        };
        setState((s) => ({
          ...s,
          tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, current: groups, updatedAt: todayStr() } : t)),
        }));
        const prevReport = stateRef.current.reports
          .filter((r) => r.analysisTaskId === taskId)
          .sort((a, b) => b.version - a.version)[0];
        const changes: ReportSnapshot['changes'] = prevReport
          ? [
              {
                label: '调试注入',
                text: `手动注入 MCP 结果：${summary.met} 满足 · ${summary.missing + summary.review} 待确认 · ${summary.notMet} 未满足`,
              },
            ]
          : [
              {
                label: '首次分析',
                text: `完成首次政策匹配：${summary.met} 满足 · ${summary.missing + summary.review} 待确认 · ${summary.notMet} 未满足`,
              },
            ];
        // 传 mcpPvId 而不是旧的 task.policyVersionId，确保 pushReport 能找到正确的政策文件
        pushReportRef.current?.(
          taskWithCurrent,
          { groups, summary: { met: summary.met, missing: summary.missing + summary.review, notMet: summary.notMet } },
          mcpPvId,
          changes
        );
      }
      console.log('[debugInject] 已注入，分组:', groups.length, '汇总:', summaryFromGroups(groups));
    },
    []
  );

  /** 删除单个分析任务（同时删除其所有报告快照和对话记录） */
  const deleteTask = useCallback((taskId: string) => {
    setState((s) => ({
      ...s,
      tasks: s.tasks.filter((t) => t.id !== taskId),
      reports: s.reports.filter((r) => r.analysisTaskId !== taskId),
      conversations: s.conversations.filter((conv) => conv.taskId !== taskId),
    }));
  }, []);

  /** 批量删除多个分析任务 */
  const deleteTasks = useCallback((taskIds: string[]) => {
    const ids = new Set(taskIds);
    setState((s) => ({
      ...s,
      tasks: s.tasks.filter((t) => !ids.has(t.id)),
      reports: s.reports.filter((r) => !ids.has(r.analysisTaskId)),
      conversations: s.conversations.filter((conv) => !ids.has(conv.taskId)),
    }));
  }, []);

  return {
    state,
    ui,
    entryConversation,
    interpretConversation,
    goalDefs: GOALS,
    aiBusy: ui.aiBusy,
    ruleResults,
    selectedAssistantId: agentSelection.selectedAssistantId,
    currentModel: modelSelection.current_model,
    refreshRuleResult,
    switchView,
    sendEntryMessage,
    sendInterpretMessage,
    openInterpret,
    askGoal,
    viewReport,
    openReportOfTask,
    updateProfileField,
    createTask,
    reanalyzeWithLatestPolicy,
    resetDemo,
    debugInjectResult,
    deleteTask,
    deleteTasks,
  };
}
