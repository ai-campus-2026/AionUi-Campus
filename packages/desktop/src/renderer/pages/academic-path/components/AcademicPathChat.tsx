/**
 * 学业路径页面的 AI 助手对话列：复用项目经过验证的 AionrsChat 组件。
 * 与规则分析页完全同构：复用 modelClient.ensureConversation（自动选 assistant/model/挂载MCP）。
 * 自动选择默认模型，避免小弹窗里"未选择模型"导致输入框禁用。
 */
import type { TProviderWithModel } from '@/common/config/storage';
import type { ChatFileRef } from '@/common/types/chatFile';
import { ensureConversation, pickDefaultModel } from '../../rule-analysis/modelClient';
import AionrsChat from '@renderer/pages/conversation/platforms/aionrs/AionrsChat';
import { useAionrsModelSelection } from '@renderer/pages/conversation/platforms/aionrs/useAionrsModelSelection';
import { ipcBridge } from '@/common';
import type { IProvider } from '@/common/config/storage';
import React, { useCallback, useEffect, useState } from 'react';
import type { Course, ProgramPlan, StudentProgress } from '../types';
import { buildAcademicContext } from '../contextBuilder';

type Props = {
  taskId: string;
  taskName: string;
  plan: ProgramPlan;
  progress: StudentProgress;
  selectedCourse: Course | null;
  assistantId?: string | null;
  initialModel?: TProviderWithModel;
  onConvIdReady?: (convId: string) => void;
};

const AcademicPathChat: React.FC<Props> = ({ taskId, taskName, plan, progress, selectedCourse, assistantId, initialModel, onConvIdReady }) => {
  const [convId, setConvId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [defaultModel, setDefaultModel] = useState<TProviderWithModel | undefined>(initialModel);

  // 自动获取默认模型（与首页/规则分析创建会话时的选择逻辑一致）
  useEffect(() => {
    if (initialModel) return;
    let cancelled = false;
    pickDefaultModel().then((m) => {
      if (!cancelled && m) setDefaultModel(m);
    });
    return () => { cancelled = true; };
  }, [initialModel]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    ensureConversation(taskId, taskName, { assistantId, model: defaultModel })
      .then((res) => {
        if (cancelled) return;
        if ('error' in res) {
          setError(res.error);
          return;
        }
        setConvId(res.id);
        onConvIdReady?.(res.id);
      })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [taskId, taskName, assistantId, defaultModel, onConvIdReady]);

  const modelSelection = useAionrsModelSelection({
    initialModel: defaultModel,
    onSelectModel: async (_provider: IProvider, modelName: string) => {
      if (!convId) return false;
      const selected = { ...(_provider as unknown as TProviderWithModel), use_model: modelName } as TProviderWithModel;
      const ok = await ipcBridge.conversation.update.invoke({ id: convId, updates: { model: selected } });
      return Boolean(ok);
    },
  });

  // 拦截发送：自动拼接学业路径上下文
  const teamSendMessage = useCallback(
    async (payload: { input: string; files: ChatFileRef[] }) => {
      if (!convId) return;
      const context = buildAcademicContext(plan, progress, selectedCourse);
      const enrichedInput = context + payload.input;
      await ipcBridge.conversation.sendMessage.invoke({
        conversation_id: convId,
        input: enrichedInput,
        files: payload.files,
      });
    },
    [convId, plan, progress, selectedCourse],
  );

  if (error) {
    return <div style={{ padding: 16, color: '#999', fontSize: 13 }}>对话创建失败：{error}</div>;
  }
  if (!convId) {
    return <div style={{ padding: 16, color: '#999', fontSize: 13 }}>正在准备对话…</div>;
  }

  return (
    <AionrsChat
      conversation_id={convId}
      workspace=''
      modelSelection={modelSelection}
      assistantId={assistantId ?? undefined}
      teamSendMessage={teamSendMessage}
    />
  );
};

export default AcademicPathChat;
