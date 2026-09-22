import type { SpeechToTextConfig } from '@/common/types/provider/speech';
import type { IMcpServer, TProviderWithModel } from '@/common/config/storage';

export type GoogleClientSetting = {
  proxy?: string;
};

export type ImageGenerationModelSetting = TProviderWithModel & {
  switch?: boolean;
};

export type ClientBusinessSettingMap = {
  'google.config': GoogleClientSetting;
  'mcp.config': IMcpServer[] | undefined;
  'tools.imageGenerationModel': ImageGenerationModelSetting | undefined;
  'tools.speechToText': SpeechToTextConfig | undefined;
  /**
   * 校园规则解码器项目共用的 DashScope API Key。
   *
   * 由 CampusApiKeyDialog 在首次启动时弹窗收集，写入后由 runBackendMigrations
   * 在下一次 bootstrap 时注入到**全部** Python stdio MCP（policy_search、rag、
   * contract-scan 合同审查以及后续新增的）的 transport.env 中。`undefined`
   * 表示从未配置过（弹窗会再次出现），空串表示用户主动清空（视为已配置但禁用）。
   */
  'tools.campusMcp.dashscopeApiKey': string | undefined;
  'acp.promptTimeout': number | undefined;
  'acp.agentIdleTimeout': number | undefined;
  /**
   * Preview size ceiling for text-like files, **in whole megabytes**.
   *
   * Stored in MB rather than bytes because that is the unit the settings field
   * presents; the byte conversion belongs to the one place that compares against a
   * file size (`resolvePreviewPayload`). Keeping the stored unit and the displayed
   * unit identical means a value read back from storage never has to be
   * reinterpreted.
   *
   * `undefined` means "never configured" and falls back to the built-in default —
   * distinct from any number the user could enter.
   */
  'preview.textSizeLimitMb': number | undefined;
};

export type ClientBusinessSettingKey = keyof ClientBusinessSettingMap;
