/**
 * Campus Rule Decoder — Workbench page (2号)
 * Apple 风格个人控制中心：中央 AI 液态玻璃输入框 + 快捷胶囊 + 最近查询 + 规则动态
 * 发送逻辑为简化版（create conversation + initial_message + navigate），
 * 不修改任何现有代码，MCP/技能使用助手默认配置。
 */
import { ipcBridge } from '@/common';
import { resolveLocaleKey } from '@/common/utils';
import type { TChatConversation, TProviderWithModel } from '@/common/config/storage';
import { Button, Empty, Grid, Input, Message, Typography } from '@arco-design/web-react';
import type { RefTextAreaType } from '@arco-design/web-react/es/Input';
import { useGuidAssistantSelection } from '@/renderer/pages/guid/hooks/useGuidAssistantSelection';
import { useGuidModelSelection } from '@/renderer/pages/guid/hooks/useGuidModelSelection';
import DocMultiPicker from '@/renderer/pages/policy-checklist/DocMultiPicker';
import { usePolicyChecklistPanel } from '@/renderer/pages/policy-checklist/checklistPanelStore';
import { getActivityTime, getTimelineLabel } from '@/renderer/utils/chat/timeline';
import { addEventListener, emitter } from '@/renderer/utils/emitter';
import { MessageOne, Right } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import styles from './WorkbenchPage.module.css';

type CreateConversationParams = Parameters<typeof ipcBridge.conversation.create.invoke>[0];

const RECENT_LIMIT = 5;

// --- 规则动态：真实政策库索引（policy-search/knowledge_base/index.json）---
// 知识库根目录由 policy-search/config.py 的 KNOWLEDGE_BASE_DIR 决定。
// 路径优先从本机 AionUi 已配置的 policy-search MCP 动态解析（各成员机器路径不同也能用），
// 解析失败时回退到本机默认路径。
const FALLBACK_INDEX_PATH =
  'D:/AI-Campus-Workspace/AionUi-Campus-SSH/policy-search/knowledge_base/index.json';
const FALLBACK_WORKSPACE_ROOT = 'D:/AI-Campus-Workspace/AionUi-Campus-SSH';

interface KnowledgeIndexRef {
  path: string;
  workspace?: string;
}

function isAbsPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/');
}

function joinPath(base: string, rel: string): string {
  const b = base.replace(/[\\/]+$/, '');
  const r = rel.replace(/^[\\/]+/, '');
  return `${b}/${r}`;
}

// 从 AionUi 已配置的 MCP server 中定位 policy-search，解析知识库索引的绝对路径。
async function resolveKnowledgeIndex(): Promise<KnowledgeIndexRef | null> {
  try {
    const servers = await ipcBridge.mcpService.listServers.invoke();
    const candidates = (servers || []).filter((s) => {
      if (!s.transport || s.transport.type !== 'stdio') return false;
      const name = (s.name || '').toLowerCase();
      const argsStr = (s.transport.args || []).join(' ').toLowerCase();
      const hasKb = !!s.transport.env?.KNOWLEDGE_BASE_DIR;
      const isPolicy = name.includes('policy') || argsStr.includes('policy-search') || hasKb;
      const isRag = name.includes('rag') || argsStr.includes('rag-mcp');
      return isPolicy && !isRag;
    });
    for (const s of candidates) {
      const t = s.transport;
      if (!t || t.type !== 'stdio') continue;
      const envDir = t.env?.KNOWLEDGE_BASE_DIR;
      const serverFile = (t.args || []).find(
        (a) => /server\.py$/i.test(a) || a.toLowerCase().includes('policy-search'),
      );
      const serverDir = serverFile ? serverFile.replace(/[\\/]+[^\\/]+$/, '') : '';
      // ① env 直接给出绝对知识库目录
      if (envDir && isAbsPath(envDir)) {
        return { path: joinPath(envDir, 'index.json'), workspace: serverDir || envDir };
      }
      // ② 由 server.py 所在目录推导（env 相对路径或默认 knowledge_base）
      if (serverDir) {
        const kbDir =
          envDir && !isAbsPath(envDir) ? joinPath(serverDir, envDir) : joinPath(serverDir, 'knowledge_base');
        const repoRoot = serverDir.replace(/[\\/]+[^\\/]+$/, ''); // policy-search 的父目录 = 仓库根
        return { path: joinPath(kbDir, 'index.json'), workspace: repoRoot };
      }
    }
  } catch (err) {
    console.warn('[workbench] MCP 配置解析失败，回退默认路径:', err);
  }
  return null;
}

// 读取知识库索引：优先带 workspace 读取，失败时尝试不带 workspace 的绝对路径。
async function readKnowledgeIndex(ref: KnowledgeIndexRef): Promise<string | null> {
  if (ref.workspace) {
    try {
      const content = await ipcBridge.fs.readFile.invoke({ path: ref.path, workspace: ref.workspace });
      if (content) return content;
    } catch {
      /* 尝试不带 workspace */
    }
  }
  try {
    return await ipcBridge.fs.readFile.invoke({ path: ref.path });
  } catch {
    return null;
  }
}

interface KnowledgeDocEntry {
  doc_id?: string;
  school?: string;
  year?: number;
  title?: string;
  file?: string;
  tags?: string[];
  effective_date?: string;
}
interface KnowledgeIndex {
  last_updated?: string;
  categories?: Record<string, KnowledgeDocEntry[]>;
}
interface RuleDynamicsItem {
  id: string;
  title: string;
  date: string;
}

/** 把知识库索引拍平为"规则动态"条目（最新施行的在前）。 */
function toRuleDynamics(index: KnowledgeIndex): RuleDynamicsItem[] {
  const categories = index?.categories ?? {};
  const docs = Object.entries(categories).flatMap(([, list]) => list ?? []);
  return docs
    .filter((doc) => doc?.title || doc?.doc_id)
    .sort((a, b) => String(b?.effective_date ?? '').localeCompare(String(a?.effective_date ?? '')))
    .map((doc) => ({
      id: doc.doc_id ?? doc.file ?? `${doc.title}-${doc.year}`,
      title: doc.title ?? doc.doc_id ?? '',
      date: doc.effective_date ? `施行 ${doc.effective_date}` : doc.year ? `${doc.year} 年` : '',
    }));
}

const WorkbenchPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const localeKey = resolveLocaleKey(i18n.language);
  const navigate = useNavigate();

  // 查询文件多选（工作台对话框旁）：用户选择 → 申请清单按所选文件渲染
  const { selectedDocs, setSelectedDocs } = usePolicyChecklistPanel();

  // --- 发送所需状态（复用 GuidPage 的 selection hooks）---
  const modelSelection = useGuidModelSelection('aionrs');
  const agentSelection = useGuidAssistantSelection({});

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [recent, setRecent] = useState<TChatConversation[]>([]);
  const [isFocused, setIsFocused] = useState(false);
  const [glow, setGlow] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<RefTextAreaType | null>(null);

  // --- 背景光晕跟随鼠标（克制幅度）---
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setGlow({
      x: ((e.clientX - rect.left) / rect.width) * 100,
      y: ((e.clientY - rect.top) / rect.height) * 100,
    });
  }, []);

  // --- 最近查询：真实会话历史（数据库）---
  const refreshRecent = useCallback(() => {
    ipcBridge.database.getUserConversations
      .invoke({ limit: 100 })
      .then((result) => {
        const items = result?.items;
        if (items && Array.isArray(items) && items.length > 0) {
          setRecent(items.toSorted((a, b) => getActivityTime(b) - getActivityTime(a)).slice(0, RECENT_LIMIT));
        } else {
          setRecent([]);
        }
      })
      .catch((error) => {
        console.error('[Workbench] Failed to load recent conversations:', error);
        setRecent([]);
      });
  }, []);
  useEffect(() => {
    refreshRecent();
    return addEventListener('chat.history.refresh', refreshRecent);
  }, [refreshRecent]);

  // --- 规则动态：挂载时读取政策库索引（上传新文档后自动变化）---
  // 声明在 sendPrompt 之前：发送时的"查询范围"注入依赖规则动态文件列表（与"查询文件"选择器同源）
  const [ruleDynamics, setRuleDynamics] = useState<RuleDynamicsItem[]>([]);
  useEffect(() => {
    let disposed = false;
    void (async () => {
      const ref =
        (await resolveKnowledgeIndex()) ?? { path: FALLBACK_INDEX_PATH, workspace: FALLBACK_WORKSPACE_ROOT };
      const content = await readKnowledgeIndex(ref);
      if (disposed) return;
      if (content) {
        try {
          setRuleDynamics(toRuleDynamics(JSON.parse(content) as KnowledgeIndex));
        } catch {
          // 索引内容异常时保持空态（显示"政策库暂无文档"）
          console.warn('[workbench] 知识库索引解析失败:', ref.path);
        }
      } else {
        // 索引不存在 / 后端未就绪 / 不在 workspace 内 → 空态，不阻塞工作台其余部分
        console.warn('[workbench] 知识库索引读取失败:', ref.path);
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  // --- 发送：简化版（create + initial_message + navigate，等价于 GuidPage 默认路径）---
  // 模型偏好：优先 qwen-plus（队友 MCP 与全组统一模型），未配置时回退当前默认模型
  const resolvePreferredModel = useCallback((): TProviderWithModel | undefined => {
    const providers = modelSelection.modelList;
    if (providers && providers.length > 0) {
      const qwenPlusProvider = providers.find((p) => p.models.some((m) => m === 'qwen-plus'));
      if (qwenPlusProvider) {
        return { ...qwenPlusProvider, use_model: 'qwen-plus' };
      }
    }
    return modelSelection.current_model;
  }, [modelSelection.modelList, modelSelection.current_model]);

  const sendPrompt = useCallback(
    async (prompt: string) => {
      const trimmed = prompt.trim();
      if (!trimmed) {
        Message.warning(t('workbench.enterText'));
        return;
      }
      const assistantId = agentSelection.selectedAssistantId;
      if (!assistantId) {
        Message.warning(t('conversation.noAssistantSelected'));
        return;
      }
      setSending(true);
      try {
        const isAionrs = agentSelection.selectedAssistantBackend === 'aionrs';
        const base: CreateConversationParams = {
          name: trimmed,
          assistant: {
            id: assistantId,
            locale: localeKey,
            conversation_overrides: {},
          },
          extra: {},
        };
        const model = isAionrs ? resolvePreferredModel() : undefined;
        const params: CreateConversationParams = model ? { ...base, model } : base;
        const conversation = await ipcBridge.conversation.create.invoke(params);
        if (!conversation?.id) {
          Message.error(t('conversation.createFailed'));
          return;
        }
        emitter.emit('chat.history.refresh');
        // 查询范围注入：工作台选了"查询文件"时，把所选知识库文件标题作为上下文附加到首条消息
        const scopedInput = selectedDocs.length > 0 ? `${t('workbench.queryScopePrefix')}：${selectedDocs.join('、')}\n${trimmed}` : trimmed;
        sessionStorage.setItem(
          `${isAionrs ? 'aionrs' : 'acp'}_initial_message_${conversation.id}`,
          JSON.stringify({ input: scopedInput })
        );
        await navigate(`/conversation/${conversation.id}`);
      } catch (error) {
        console.error('[Workbench] Failed to create conversation:', error);
        Message.error(t('conversation.createFailed'));
      } finally {
        setSending(false);
      }
    },
    [agentSelection.selectedAssistantId, agentSelection.selectedAssistantBackend, localeKey, resolvePreferredModel, navigate, t, selectedDocs]
  );

  // --- 快捷胶囊：点击把问题带入输入框（不直接发送，用户可编辑）---
  const pills = useMemo(
    () => [
      { key: 'scholarship', label: t('workbench.pillScholarship'), prompt: t('workbench.pillScholarshipPrompt') },
      { key: 'leave', label: t('workbench.pillLeave'), prompt: t('workbench.pillLeavePrompt') },
      { key: 'dorm', label: t('workbench.pillDorm'), prompt: t('workbench.pillDormPrompt') },
      { key: 'exam', label: t('workbench.pillExam'), prompt: t('workbench.pillExamPrompt') },
      { key: 'study', label: t('workbench.pillStudy'), prompt: t('workbench.pillStudyPrompt') },
    ],
    [t]
  );

  const applyPill = useCallback((prompt: string) => {
    setInput(prompt);
    inputRef.current?.focus();
  }, []);

  // --- 问候语：按当前时段变化（不写死固定问候） ---
  const greetingKey = useMemo(() => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 11) return 'greetingMorning';
    if (hour >= 11 && hour < 13) return 'greetingNoon';
    if (hour >= 13 && hour < 18) return 'greetingAfternoon';
    if (hour >= 18 && hour < 23) return 'greetingEvening';
    return 'greetingNight';
  }, []);

  return (
    <div
      className={styles.workbench}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setGlow(null)}
    >
      {/* 环境光晕：两个常驻光斑 + 鼠标跟随光斑（液态玻璃的可视基础） */}
      <div
        className={styles.ambientLayer}
        style={
          glow
            ? ({ '--glow-x': `${glow.x}%`, '--glow-y': `${glow.y}%` } as React.CSSProperties)
            : undefined
        }
      />

      <div className={`${styles.content} mx-auto flex flex-col gap-26px pt-48px px-24px pb-48px`} style={{ maxWidth: 780 }}>
        {/* 标题区 */}
        <div>
          <Typography.Title heading={4} style={{ marginBottom: 4 }}>
            {t(greetingKey)}
          </Typography.Title>
          <Typography.Text type='secondary' style={{ fontSize: 15 }}>
            {t('workbench.subGreeting')}
          </Typography.Text>
        </div>

        {/* 查询文件多选（对话框旁）：与"规则动态"同源（知识库真实文件），所选文件作为查询范围 */}
        <div className='flex items-center gap-8px flex-wrap'>
          <Typography.Text type='secondary' style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
            {t('workbench.docPickerLabel')}
          </Typography.Text>
          <DocMultiPicker
            value={selectedDocs}
            onChange={setSelectedDocs}
            options={ruleDynamics.map((rule) => ({ label: rule.title, value: rule.title }))}
          />
          {selectedDocs.length > 0 && (
            <Typography.Text type='secondary' style={{ fontSize: 11 }}>
              {t('workbench.queryScopeHint')}
            </Typography.Text>
          )}
        </div>

        {/* 中央 AI 输入框（强液态玻璃 + AI 呼吸图标） */}
        <div className={`${styles.inputGlass} ${isFocused ? styles.inputGlassFocus : ''} flex flex-row gap-14px p-18px`}>
          <div className={styles.aiIcon}>✦</div>
          <div className='flex flex-col gap-8px flex-1 min-w-0'>
            <Input.TextArea
              ref={inputRef}
              value={input}
              onChange={setInput}
              placeholder={t('workbench.inputPlaceholder')}
              autoSize={{ minRows: 2, maxRows: 6 }}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault();
                  void sendPrompt(input);
                }
              }}
              style={{ background: 'transparent', border: 'none', boxShadow: 'none', fontSize: 15 }}
            />
            <div className='flex items-center justify-between gap-8px'>
              <Typography.Text type='secondary' style={{ fontSize: 12 }}>
                {t('workbench.exampleHint')}
              </Typography.Text>
              <Button
                type='primary'
                loading={sending}
                disabled={!input.trim()}
                onClick={() => void sendPrompt(input)}
                style={{ borderRadius: 999 }}
              >
                {t('workbench.send')}
              </Button>
            </div>
          </div>
        </div>

        {/* 快捷胶囊 */}
        <div className='flex flex-wrap items-center gap-10px'>
          {pills.map((pill) => (
            <span key={pill.key} className={styles.pill} onClick={() => applyPill(pill.prompt)}>
              {pill.label}
            </span>
          ))}
        </div>

        {/* 下方两区：最近查询 | 规则动态 */}
        <Grid.Row gutter={[16, 16]}>
          <Grid.Col xs={24} sm={14}>
            <div className='flex flex-col gap-12px'>
              <Typography.Title heading={6} style={{ marginBottom: 0 }}>
                {t('workbench.recentTitle')}
              </Typography.Title>
              {recent.length === 0 ? (
                <div className={`${styles.infoCard} ${styles.infoCardRecent} p-24px flex items-center justify-center`}>
                  <Empty description={t('workbench.recentEmpty')} />
                </div>
              ) : (
                <div className={`${styles.infoCard} ${styles.infoCardRecent} p-6px flex flex-col gap-2px`}>
                  {recent.map((conversation) => (
                    <div
                      key={conversation.id}
                      className={styles.infoRow}
                      onClick={() => void navigate(`/workbench/report/${conversation.id}`)}
                    >
                      <div className='flex items-center gap-10px min-w-0 flex-1'>
                        {/* 左侧消息图标：回到该会话记录（不触发行点击） */}
                        <span
                          className={styles.rowIcon}
                          title={t('workbench.enterConversation')}
                          onClick={(e) => {
                            e.stopPropagation();
                            void navigate(`/conversation/${conversation.id}`);
                          }}
                        >
                          <MessageOne theme='outline' size='16' />
                        </span>
                        <span className={styles.rowDivider} />
                        <div className='flex flex-col min-w-0'>
                          <Typography.Text ellipsis style={{ maxWidth: 360, fontSize: 13 }}>
                            {conversation.name}
                          </Typography.Text>
                          <Typography.Text type='secondary' style={{ fontSize: 12 }}>
                            {getTimelineLabel(getActivityTime(conversation), Date.now(), t)}
                          </Typography.Text>
                        </div>
                      </div>
                      <span
                        className='shrink-0 px-8px py-2px rd-999px'
                        style={{ background: 'var(--color-fill-3)', fontSize: 12, color: 'var(--color-text-2)' }}
                      >
                        {t('workbench.recentTagAi')}
                      </span>
                      <Right theme='outline' size='12' style={{ color: 'var(--color-text-3)', flexShrink: 0 }} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Grid.Col>

          <Grid.Col xs={24} sm={10}>
            <div className='flex flex-col gap-12px'>
              <Typography.Title heading={6} style={{ marginBottom: 0 }}>
                {t('workbench.ruleDynamicsTitle')}
              </Typography.Title>
              <div className={`${styles.infoCard} ${styles.infoCardLight} p-6px flex flex-col gap-2px`}>
                {ruleDynamics.length === 0 ? (
                  <div className='p-24px flex items-center justify-center'>
                    <Empty description={t('workbench.ruleDynamicsEmpty')} />
                  </div>
                ) : (
                  ruleDynamics.map((rule) => (
                    <div
                      key={rule.id}
                      className={styles.infoRow}
                      onClick={() => applyPill(`请查询《${rule.title}》相关规定`)}
                    >
                      <div className='flex items-start gap-8px min-w-0 flex-1'>
                        <span className={`${styles.dynDot} mt-7px`} />
                        <div className='flex flex-col min-w-0 gap-1px'>
                          <Typography.Text ellipsis style={{ maxWidth: 240, fontSize: 13 }}>
                            {rule.title}
                          </Typography.Text>
                          <Typography.Text type='secondary' style={{ fontSize: 12 }}>
                            {rule.date}
                          </Typography.Text>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </Grid.Col>
        </Grid.Row>
      </div>
    </div>
  );
};

export default WorkbenchPage;
