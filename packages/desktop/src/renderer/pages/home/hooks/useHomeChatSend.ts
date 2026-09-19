/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IProvider, TProviderWithModel } from '@/common/config/storage';
import { isAionrsAssistant, type Assistant } from '@/common/types/agent/assistantTypes';
import { resolveLocaleKey } from '@/common/utils';
import { useCustomAgentsLoader } from '@renderer/pages/guid/hooks/useCustomAgentsLoader';
import { pickDefaultAssistantSelectionKey } from '@renderer/pages/guid/hooks/useGuidAssistantSelection';
import { useGuidModelSelection } from '@renderer/pages/guid/hooks/useGuidModelSelection';
import { getConversationCreateErrorMessage } from '@renderer/pages/conversation/utils/conversationCreateError';
import { emitter } from '@renderer/utils/emitter';
import { Message } from '@arco-design/web-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { mutate as swrMutate } from 'swr';

export type HomeChatSendResult = {
  /** Provider list with at least one available model (same source as Guid). */
  modelList: IProvider[];
  /** Currently selected provider model; auto-defaults to the first available. */
  currentModel: TProviderWithModel | undefined;
  setCurrentModel: (model: TProviderWithModel) => Promise<void>;
  /** True while a conversation is being created. */
  sending: boolean;
  /**
   * Create a real backend conversation from the home chat input and navigate
   * to it. Mirrors the aionrs branch of `useGuidSend`: create conversation →
   * stash the initial message in sessionStorage → open `/conversation/:id`.
   */
  send: (input: string) => Promise<void>;
};

/**
 * Send logic for the new home page chat box.
 *
 * Resolves the default assistant from the shared catalog (preferring aionrs,
 * same rule as the Guid page) and the provider model selection, then creates
 * a real conversation through the IPC bridge. Non-aionrs assistants fall back
 * to the battle-tested `/guid` prefill navigation contract instead.
 */
export const useHomeChatSend = (): HomeChatSendResult => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { assistants } = useCustomAgentsLoader();
  const modelSelection = useGuidModelSelection('aionrs');
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);

  const selectedAssistant: Assistant | undefined = useMemo(() => {
    const defaultId = pickDefaultAssistantSelectionKey(assistants);
    return assistants.find((assistant) => assistant.id === defaultId);
  }, [assistants]);

  const send = useCallback(
    async (input: string) => {
      const text = input.trim();
      if (!text || sendingRef.current) return;

      if (!selectedAssistant) {
        Message.warning(t('guid.selectAssistantHint', { defaultValue: 'Select an assistant to start' }));
        return;
      }

      // Non-provider assistants (ACP/CLI backends) own their model lists and
      // need the full Guid setup flow — hand off via the prefill contract.
      if (!isAionrsAssistant(selectedAssistant)) {
        navigate('/guid', {
          state: { selectedAssistantId: selectedAssistant.id, prefillPrompt: text },
        });
        return;
      }

      const currentModel = modelSelection.current_model;
      if (!currentModel) {
        Message.warning(t('conversation.noModelConfigured'));
        return;
      }

      sendingRef.current = true;
      setSending(true);
      try {
        const localeKey = resolveLocaleKey(i18n.language);
        const conversation = await ipcBridge.conversation.create.invoke({
          name: text,
          model: currentModel,
          assistant: {
            id: selectedAssistant.id,
            locale: localeKey,
            conversation_overrides: { model: currentModel.use_model },
          },
          extra: {},
        });

        if (!conversation || !conversation.id) {
          Message.error(t('conversation.createFailed'));
          return;
        }

        await swrMutate('assistants.list');
        emitter.emit('chat.history.refresh');

        sessionStorage.setItem(
          `aionrs_initial_message_${conversation.id}`,
          JSON.stringify({ input: text })
        );

        await navigate(`/conversation/${conversation.id}`);
      } catch (error) {
        console.error('[HomeChat] Failed to create conversation:', error);
        Message.error(getConversationCreateErrorMessage(error, t));
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [selectedAssistant, modelSelection.current_model, navigate, t, i18n.language]
  );

  return {
    modelList: modelSelection.modelList,
    currentModel: modelSelection.current_model,
    setCurrentModel: modelSelection.setCurrentModel,
    sending,
    send,
  };
};

export default useHomeChatSend;
