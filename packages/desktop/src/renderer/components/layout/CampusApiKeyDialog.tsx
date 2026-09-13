/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 校园规则解码器 MCP 的 DashScope API Key 首次配置弹窗。
 *
 * 触发条件（自动弹出，三者同时满足）：
 *   1. 后端 client preferences 里 `tools.campusMcp.dashscopeApiKey` 为空/未设置；
 *   2. MCP 列表里存在「本项目 bootstrap 注册的内置 Python MCP」（builtin 且用
 *      python 启动）—— 这说明 campusMcpBootstrap 已探测到仓库并完成注册，当前是
 *      开发态；用这个特征当闸门，避免在生产构建里打扰只是恰好装了某个无关 Python
 *      MCP 的最终用户；
 *   3. 列表里**任意一个** Python stdio MCP 的 transport.env 还没有 DASHSCOPE_API_KEY
 *      —— 注意不能看 enabled 标志：Python server 没有 key 也能正常启动并通过连接
 *      测试，enabled 只说明「进程起来了」，不代表「配置好了」。
 *
 * 检测与注入都不靠硬编码名字：凡是 `python xxx/server.py` 形态的 stdio MCP 都算
 * 校园 MCP（policy_search、rag、contract-scan 合同审查，以及后续新增的），保存时
 * 会把 key 注入到当前列表里的**全部**这类条目。
 *
 * 手动入口：设置 → 工具 页的提示条通过 campusApiKeyDialogBus 发事件打开本弹窗
 * （此时即使 preferences 里已有 key 也打开，输入框预填旧值，方便更换）。
 *
 * 保存动作：
 *   - 把 key 写进 client preferences（下次启动 bootstrap 直接读到，不必再弹）；
 *   - 同步更新列表里全部 Python MCP 条目的 transport.env 与 enabled=true，让本次
 *     会话立刻可用，不必重启应用。
 *
 * 「稍后再说」只关闭弹窗，不写任何持久化标记 —— 下次启动还会再弹。这是有意的：
 * 开发态下 key 是必需品，反复提醒比静默禁用更友好；真正不想用的人可以在设置里
 * 把这些 MCP 条目删掉（弹窗检测不到内置 Python MCP 就不再出现），或者配置过 key
 * 之后再手动禁用（preferences 里已有 key 会直接短路，同样不会再弹）。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Input, Message, Typography } from '@arco-design/web-react';
import { mcpService } from '@/common/adapter/ipcBridge';
import type { IMcpServer } from '@/common/config/storage';
import { getClientBusinessSetting, setClientBusinessSetting } from '@/renderer/services/clientBusinessSettings';
import {
  notifyCampusApiKeyDialogSaved,
  onCampusApiKeyDialogOpenRequest,
} from '@/renderer/services/campusApiKeyDialogBus';
import AionModal from '@/renderer/components/base/AionModal';
import { toBackendMcpPayload } from '@/renderer/hooks/mcp/catalog';
import {
  collectCampusPythonServers,
  hasBootstrapCampusServer,
  hasCampusEnvKey,
  withCampusApiKey,
} from '@/common/config/campusMcp';

const CAMPUS_SETTING_KEY = 'tools.campusMcp.dashscopeApiKey' as const;

const CampusApiKeyDialog: React.FC = () => {
  const [visible, setVisible] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [campusServers, setCampusServers] = useState<IMcpServer[]>([]);

  /**
   * 拉取 MCP 列表，挑出全部需要注入 key 的 Python MCP。
   *
   * 闸门：列表里必须存在「bootstrap 注册的内置 Python MCP」才返回（说明当前是
   * 开发态、仓库已探测到）；否则返回 null（生产构建、或用户把内置条目删光了），
   * 弹窗没有意义。返回的是**全部** Python MCP（含用户手动添加、源码在仓库外的
   * contract-scan 等），不再只认 policy_search / rag 两个名字。
   */
  const loadCampusServers = useCallback(async (): Promise<IMcpServer[] | null> => {
    const servers = (await mcpService.listServers.invoke()) || [];
    if (!hasBootstrapCampusServer(servers)) return null;
    const targets = collectCampusPythonServers(servers);
    return targets.length > 0 ? targets : null;
  }, []);

  /**
   * 启动时检查是否需要自动弹窗。
   *
   * 顺序很重要：先读 key（便宜），再读 MCP 列表（贵一点）。key 已配置就直接
   * 短路，连 MCP 列表都不用拉，避免每次启动都多一次 IPC。
   *
   * 注意不看 enabled：Python server 没 key 也能启动并通过连接测试（设置页绿勾），
   * 只有 env 里真的没有 DASHSCOPE_API_KEY 才说明还没配置好、需要提醒。
   */
  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const existingKey = await getClientBusinessSetting(CAMPUS_SETTING_KEY);
        if (existingKey && existingKey.trim()) return; // 已配置，不打扰

        const targets = await loadCampusServers();
        // 存在 bootstrap 注册的内置 Python MCP，才说明探测到了仓库、当前是开发态 ——
        // 否则可能是生产构建或者用户把内置条目删过，弹窗没有意义
        if (!targets) return;
        // 列表里每一个 Python MCP 都已经在 env 里带了 key（用户自己填过），不再打扰
        if (targets.every(hasCampusEnvKey)) return;

        if (cancelled) return;
        setCampusServers(targets);
        setVisible(true);
      } catch (error) {
        // 探测失败不应该阻塞应用启动，静默记日志即可
        console.warn('[CampusApiKeyDialog] preflight check failed', error);
      }
    };

    void check();
    return () => {
      cancelled = true;
    };
  }, [loadCampusServers]);

  /**
   * 手动入口：设置 → 工具 页提示条点「填写 API Key」时发事件打开本弹窗。
   * 此时即使 preferences 里已有 key 也打开（输入框预填旧值），方便更换。
   */
  useEffect(
    () =>
      onCampusApiKeyDialogOpenRequest(() => {
        const open = async () => {
          try {
            const targets = await loadCampusServers();
            if (!targets) return;
            const existingKey = await getClientBusinessSetting(CAMPUS_SETTING_KEY);
            setCampusServers(targets);
            setApiKey(existingKey && existingKey.trim() ? existingKey : '');
            setVisible(true);
          } catch (error) {
            console.warn('[CampusApiKeyDialog] manual open failed', error);
          }
        };
        void open();
      }),
    [loadCampusServers]
  );

  const handleSkip = useCallback(() => {
    setVisible(false);
  }, []);

  const handleSave = useCallback(async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      Message.warning('请输入 DashScope API Key');
      return;
    }
    if (campusServers.length === 0) {
      // 理论上不会发生（visible=true 时一定已经填好 campusServers），防御性兜底
      setVisible(false);
      return;
    }

    setSaving(true);
    try {
      // 1. 持久化 key，下次启动 bootstrap 直接读到
      await setClientBusinessSetting(CAMPUS_SETTING_KEY, trimmed);

      // 2. 同步更新全部 Python MCP 条目，本次会话立刻生效
      for (const server of campusServers) {
        const updated = withCampusApiKey(server, trimmed);
        await mcpService.updateServer.invoke({
          id: updated.id,
          data: toBackendMcpPayload(updated),
        });
        // enabled 不在 toBackendMcpPayload 的字段里，单独走 toggle/enable 接口
        if (!server.enabled) {
          try {
            await mcpService.toggleServer.invoke({ id: updated.id });
          } catch (toggleError) {
            // toggle 失败不算致命：key 已经写进 env，下次启动 bootstrap 会把
            // enabled 翻成 true。这里只记日志，不打断保存流程。
            console.warn('[CampusApiKeyDialog] toggleServer failed for %s', updated.id, toggleError);
          }
        }
      }

      const names = campusServers.map((server) => server.name).join('、');
      Message.success(`已保存，已为 ${campusServers.length} 个 MCP 注入 Key：${names}`);
      notifyCampusApiKeyDialogSaved();
      setVisible(false);
      setApiKey('');
    } catch (error) {
      console.error('[CampusApiKeyDialog] save failed', error);
      Message.error(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  }, [apiKey, campusServers]);

  const subtitle = useMemo(() => {
    const pending = campusServers.filter((server) => !hasCampusEnvKey(server));
    const names = (pending.length > 0 ? pending : campusServers).map((server) => server.name).join('、');
    return names ? `检测到 ${names} 等 MCP 尚未配置 DashScope API Key` : '检测到校园 MCP 尚未配置 DashScope API Key';
  }, [campusServers]);

  return (
    <AionModal
      visible={visible}
      variant='standard'
      size='medium'
      maskClosable={false}
      header={{
        title: '配置 DashScope API Key',
        subtitle,
        showClose: true,
      }}
      footer={{
        render: () => (
          <div className='flex justify-end gap-8px'>
            <button
              type='button'
              onClick={handleSkip}
              disabled={saving}
              className='px-16px py-6px rd-6px border border-solid border-[var(--bg-3)] bg-transparent text-t-secondary cursor-pointer hover:bg-2 disabled:opacity-50 disabled:cursor-not-allowed'
            >
              稍后再说
            </button>
            <button
              type='button'
              onClick={handleSave}
              disabled={saving || !apiKey.trim()}
              className='px-16px py-6px rd-6px border-0 bg-[var(--primary-6)] text-white cursor-pointer hover:bg-[var(--primary-5)] disabled:opacity-50 disabled:cursor-not-allowed'
            >
              {saving ? '保存中…' : '保存并启用'}
            </button>
          </div>
        ),
      }}
      onCancel={handleSkip}
    >
      <div className='flex flex-col gap-16px'>
        <Typography.Paragraph className='m-0 text-13px text-t-secondary leading-20px'>
          校园规则解码器的全部 MCP（政策结构化匹配、向量检索、合同审查等）都依赖 阿里云 DashScope 的 embedding / rerank
          / LLM 接口。请在下方输入框里填入你的 API Key，保存后会自动注入到检测到的每一个 MCP 并启用它们。
        </Typography.Paragraph>

        {campusServers.length > 0 && (
          <div className='flex flex-col gap-6px px-12px py-10px rd-8px bg-fill-2'>
            <span className='text-12px font-600 text-t-primary'>
              已自动检测到 {campusServers.length} 个 MCP，保存后将注入 Key：
            </span>
            <div className='flex flex-wrap gap-6px'>
              {campusServers.map((server) => (
                <span
                  key={server.id}
                  className='px-8px py-2px rd-6px text-12px border border-solid border-[var(--bg-3)] bg-[var(--dialog-fill-0)] text-t-secondary'
                >
                  {server.name}
                  {hasCampusEnvKey(server) ? '（已有 Key，将覆盖）' : ''}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className='flex flex-col gap-6px'>
          <label htmlFor='campus-dashscope-api-key' className='text-13px font-600 text-t-primary leading-18px'>
            DashScope API Key
          </label>
          <Input.Password
            id='campus-dashscope-api-key'
            aria-label='DashScope API Key'
            size='large'
            value={apiKey}
            onChange={setApiKey}
            placeholder='在这里粘贴 sk- 开头的密钥'
            disabled={saving}
            autoFocus
            onPressEnter={() => {
              if (!saving && apiKey.trim()) void handleSave();
            }}
          />
          <Typography.Paragraph className='m-0 text-12px text-t-tertiary leading-18px'>
            还没有 Key？到
            <a
              href='https://dashscope.console.aliyun.com/'
              target='_blank'
              rel='noreferrer'
              className='text-[var(--primary-6)] no-underline hover:underline'
            >
              dashscope.console.aliyun.com
            </a>
            免费创建后粘贴到上方输入框，填完点「保存并启用」或直接按回车。
          </Typography.Paragraph>
        </div>

        <Typography.Paragraph className='m-0 text-12px text-t-tertiary leading-18px'>
          Key 只会写入本地后端数据库，不会上传到任何第三方服务。保存后启动不会再弹本窗口； 如需更换或清除，到「设置 →
          工具」页编辑这些条目的 env 字段 （DASHSCOPE_API_KEY），清除后该页会重新出现提示条，点它可再次打开本窗口。
        </Typography.Paragraph>
      </div>
    </AionModal>
  );
};

export default CampusApiKeyDialog;
