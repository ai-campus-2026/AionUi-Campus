/**
 * 规则分析页面的聊天列：直接复用项目经过验证的 AionrsChat 组件，
 * 包含完整的流式处理、MCP 工具调用、权限确认、思考过程展示等。
 * 顶部增加知识库文件选择器：选中后不自动发消息，而是在用户每次发送时
 * 通过 teamSendMessage 拦截，自动在消息前附加查询范围，实现"真正应用"。
 */
import { ipcBridge } from '@/common';
import type { ChatFileRef } from '@/common/types/chatFile';
import type { IProvider, TProviderWithModel } from '@/common/config/storage';
import { ensureConversation } from '../modelClient';
import { loadKnowledgeDocs, type KnowledgeDoc } from '../knowledgeBase';
import AionrsChat from '@renderer/pages/conversation/platforms/aionrs/AionrsChat';
import { useAionrsModelSelection } from '@renderer/pages/conversation/platforms/aionrs/useAionrsModelSelection';
import { Select } from '@arco-design/web-react';
import { FileText, Close } from '@icon-park/react';
import React, { useCallback, useEffect, useState } from 'react';

type Props = {
  taskId: string;
  taskName: string;
  assistantId?: string | null;
  initialModel?: TProviderWithModel;
  /** 会话创建完成后回调 */
  onReady?: (conversationId: string) => void;
};

const RuleAnalysisChat: React.FC<Props> = ({ taskId, taskName, assistantId, initialModel, onReady }) => {
  const [convId, setConvId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const readyRef = React.useRef(false);

  // 知识库文件列表 & 选中的查询范围
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [selectedDocs, setSelectedDocs] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    loadKnowledgeDocs().then((list) => {
      if (!cancelled) setDocs(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 创建/复用会话
  useEffect(() => {
    let cancelled = false;
    setError(null);
    ensureConversation(taskId, taskName, { assistantId, model: initialModel })
      .then((res) => {
        if (cancelled) return;
        if ('error' in res) {
          setError(res.error);
          return;
        }
        setConvId(res.id);
        if (!readyRef.current && onReady) {
          readyRef.current = true;
          onReady(res.id);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, taskName, assistantId, initialModel, onReady]);

  const modelSelection = useAionrsModelSelection({
    initialModel,
    onSelectModel: async (_provider: IProvider, modelName: string) => {
      if (!convId) return false;
      const selected = { ...(_provider as unknown as TProviderWithModel), use_model: modelName } as TProviderWithModel;
      const ok = await ipcBridge.conversation.update.invoke({ id: convId, updates: { model: selected } });
      return Boolean(ok);
    },
  });

  /**
   * 拦截发送：如果选中了知识库文件，自动在消息前附加查询范围。
   * 这不是"自动发消息"，而是在用户主动发送时注入范围，实现真正的文件限定。
   */
  const handleTeamSend = useCallback(
    async (payload: { input: string; files: ChatFileRef[] }) => {
      if (!convId) return;
      let finalInput = payload.input;
      if (selectedDocs.length > 0) {
        const fileList = selectedDocs.map((t) => `《${t}》`).join('、');
        finalInput = `【查询范围】仅基于以下政策文件进行分析，不要检索知识库中的其他文件：${fileList}\n\n${payload.input}`;
      }
      try {
        await ipcBridge.conversation.sendMessage.invoke({
          conversation_id: convId,
          input: finalInput,
          files: payload.files,
        });
      } catch {
        // 发送失败由 AionrsSendBox 的通用错误处理兜底
      }
    },
    [convId, selectedDocs],
  );

  if (error) {
    return (
      <div style={{ padding: 16, color: '#999', fontSize: 13 }}>
        对话创建失败：{error}
      </div>
    );
  }

  if (!convId) {
    return (
      <div style={{ padding: 16, color: '#999', fontSize: 13 }}>
        正在准备对话…
      </div>
    );
  }

  return (
    <>
      {/* 知识库文件选择器：选中即生效，不自动发消息；用户发送时自动附加范围 */}
      {docs.length > 0 && (
        <div className='ra-chat__scopebar' style={{ flex: '0 0 auto' }}>
          <div className='ra-chat__scopebar-row'>
            <FileText theme='outline' size={13} style={{ opacity: 0.6, flexShrink: 0 }} />
            <Select
              mode='multiple'
              value={selectedDocs}
              onChange={(next) => setSelectedDocs(next as string[])}
              size='mini'
              placeholder='选择政策文件限定查询范围'
              style={{ flex: 1, minWidth: 0 }}
              maxTagCount={2}
              options={docs.map((d) => ({ label: d.title, value: d.title }))}
            />
            {selectedDocs.length > 0 && (
              <button
                type='button'
                className='ra-chat__scopebar-clear'
                onClick={() => setSelectedDocs([])}
                title='清除范围'
              >
                <Close size={11} theme='outline' fill='currentColor' />
              </button>
            )}
          </div>
          {selectedDocs.length > 0 && (
            <div className='ra-chat__scopebar-hint ra-chat__scopebar-hint--active'>
              已限定 {selectedDocs.length} 份文件，发送问题时将自动基于这些文件分析
            </div>
          )}
        </div>
      )}

      <AionrsChat
        conversation_id={convId}
        workspace=''
        modelSelection={modelSelection}
        assistantId={assistantId ?? undefined}
        teamSendMessage={handleTeamSend}
      />
    </>
  );
};

export default RuleAnalysisChat;
