import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Home } from '@icon-park/react';
import { ipcBridge } from '@/common';
import { loadKnowledgeDocs, type KnowledgeDoc } from '@renderer/pages/rule-analysis/knowledgeBase';
import type { SelectedPolicyFile, ComparisonHistoryRecord, PolicyDiffResult } from './types';
import { mockDiffResult } from './mockData';
import {
  ensureComparisonConversation,
  sendComparisonRequest,
  loadLatestDiffResult,
  checkMcpAvailable,
} from './policyComparisonClient';
import { tryParsePolicyDiffResult } from './adaptDiffResult';

type Props = {
  history: ComparisonHistoryRecord[];
  onSaveHistory: (record: ComparisonHistoryRecord) => void;
  onStartCompare: (result: PolicyDiffResult, oldFile: SelectedPolicyFile, newFile: SelectedPolicyFile) => void;
  onOpenHistory: () => void;
};

/** 格式化文件大小 */
function formatSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 从文件名推断版本 */
function inferVersion(filename: string): string {
  const m = filename.match(/(20\d{2})/);
  return m ? `${m[1]}版` : '';
}

/** 政策对比入口页 */
const PolicyEntryView: React.FC<Props> = ({ history, onSaveHistory, onStartCompare, onOpenHistory }) => {
  const navigate = useNavigate();
  const [oldFile, setOldFile] = useState<SelectedPolicyFile | null>(null);
  const [newFile, setNewFile] = useState<SelectedPolicyFile | null>(null);
  const [confirmMode, setConfirmMode] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeStep, setAnalyzeStep] = useState(0);
  const [kbDocs, setKbDocs] = useState<KnowledgeDoc[]>([]);
  const [kbPickerFor, setKbPickerFor] = useState<'old' | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [analyzeStatus, setAnalyzeStatus] = useState<
    'running' | 'success' | 'no_mcp' | 'timeout' | 'parse_failed' | 'error'
  >('running');
  const [analyzeErrorMsg, setAnalyzeErrorMsg] = useState<string>('');
  const [mcpAvailable, setMcpAvailable] = useState<boolean | null>(null);
  // ---- 调试：JSON 注入 ----
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugJson, setDebugJson] = useState('');
  const [debugError, setDebugError] = useState<string | null>(null);

  const bothReady = !!oldFile && !!newFile;

  // ---- 调试：Ctrl+Shift+D 打开注入面板 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        setDebugOpen((v) => !v);
      }
      if (e.key === 'Escape') setDebugOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- 加载知识库文件列表 ----
  useEffect(() => {
    let cancelled = false;
    loadKnowledgeDocs().then((docs) => {
      if (!cancelled) setKbDocs(docs);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- 上传文件 ----
  const handleUpload = useCallback(async (target: 'old' | 'new') => {
    try {
      const files = await ipcBridge.dialog.showOpen.invoke({
        properties: ['openFile'],
        filters: [{ name: '政策文件', extensions: ['pdf', 'doc', 'docx', 'txt', 'md'] }],
      });
      if (files && files.length > 0) {
        const filePath = files[0];
        const name = filePath.split(/[\\/]/).pop() || filePath;
        const file: SelectedPolicyFile = {
          name,
          version: inferVersion(name),
          type: name.split('.').pop()?.toUpperCase(),
          path: filePath,
          source: 'upload',
        };
        if (target === 'old') setOldFile(file);
        else setNewFile(file);
        setConfirmMode(false);
        setError(null);
      }
    } catch (err) {
      console.error('文件选择失败:', err);
    }
  }, []);

  // ---- 从知识库选择 ----
  const handleKbSelect = useCallback(
    (doc: KnowledgeDoc) => {
      const file: SelectedPolicyFile = {
        name: doc.title,
        version: doc.year ? `${doc.year}版` : doc.effectiveDate || '',
        type: '知识库',
        source: 'knowledge',
        docId: doc.id,
      };
      if (kbPickerFor === 'old') setOldFile(file);
      else setNewFile(file);
      setKbPickerFor(null);
      setConfirmMode(false);
      setError(null);
    },
    [kbPickerFor]
  );

  // ---- 交换文件 ----
  const handleSwap = useCallback(() => {
    setOldFile(newFile);
    setNewFile(oldFile);
    setConfirmMode(false);
  }, [oldFile, newFile]);

  // ---- 清除文件 ----
  const handleClear = useCallback((target: 'old' | 'new') => {
    if (target === 'old') setOldFile(null);
    else setNewFile(null);
    setConfirmMode(false);
  }, []);

  // ---- 开始对比 ----
  const handleStart = useCallback(async () => {
    if (!oldFile || !newFile) return;
    setConfirmMode(true);
    // 提前检查 MCP 是否配置，避免进入解析动画后才发现没配置
    try {
      const available = await checkMcpAvailable();
      setMcpAvailable(available);
    } catch {
      setMcpAvailable(false);
    }
  }, [oldFile, newFile]);

  const handleConfirmStart = useCallback(async () => {
    if (!oldFile || !newFile) return;
    setAnalyzing(true);
    setAnalyzeStep(0);
    setError(null);
    setAnalyzeStatus('running');
    setAnalyzeErrorMsg('');

    const steps = ['解析旧政策', '解析新政策', '建立条例对应关系', '识别修改、新增和删除'];
    let stepIdx = 0;
    const stepTimer = setInterval(() => {
      stepIdx = Math.min(stepIdx + 1, steps.length - 1);
      setAnalyzeStep(stepIdx);
    }, 800);

    const saveAndGo = (result: PolicyDiffResult) => {
      const record: ComparisonHistoryRecord = {
        id: `cmp_${Date.now()}`,
        docName: result.document.name,
        oldVersion: result.document.oldVersion,
        newVersion: result.document.newVersion,
        oldFile: oldFile!.name,
        newFile: newFile!.name,
        createdAt: new Date().toISOString(),
        summary: result.summary,
        diffSnapshot: result,
      };
      onSaveHistory(record);
      setAnalyzing(false);
      onStartCompare(result, oldFile!, newFile!);
    };

    try {
      // ---- 1. 创建对话（MCP 已在确认状态提前检查，这里兜底） ----
      const conv = await ensureComparisonConversation();
      if ('error' in conv) {
        if (conv.error === 'NO_MCP_CONFIGURED') {
          clearInterval(stepTimer);
          setAnalyzeStep(steps.length - 1);
          setAnalyzeStatus('no_mcp');
          return;
        }
        throw new Error(conv.error);
      }

      // ---- 2. 发送对比请求 ----
      const sendRes = await sendComparisonRequest(conv.id, oldFile.name, newFile.name);
      if (!sendRes.ok && !sendRes.isConflict) {
        throw new Error(sendRes.error || '发送对比请求失败');
      }

      // ---- 3. 轮询 MCP 结果（最多 30 秒） ----
      let result: PolicyDiffResult | null = null;
      let lastStatus: 'no_tool_output' | 'parse_failed' = 'no_tool_output';
      const pollStart = Date.now();
      while (Date.now() - pollStart < 30000) {
        await new Promise((r) => setTimeout(r, 2000));
        const loaded = await loadLatestDiffResult(conv.id);
        if (loaded.status === 'ok' && loaded.result) {
          result = loaded.result;
          break;
        }
        lastStatus = loaded.status === 'parse_failed' ? 'parse_failed' : 'no_tool_output';
      }

      clearInterval(stepTimer);
      setAnalyzeStep(steps.length - 1);

      if (!result) {
        clearInterval(stepTimer);
        setAnalyzeStep(steps.length - 1);
        if (lastStatus === 'parse_failed') {
          setAnalyzeStatus('parse_failed');
        } else {
          setAnalyzeStatus('timeout');
        }
        return;
      }
      // 成功
      clearInterval(stepTimer);
      setAnalyzeStep(steps.length - 1);
      setAnalyzeStatus('success');
      await new Promise((r) => setTimeout(r, 600));
      saveAndGo(result);
    } catch (e) {
      clearInterval(stepTimer);
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error('[policy-comparison] MCP 调用失败:', errMsg);
      setAnalyzeErrorMsg(errMsg);
      setAnalyzeStatus('error');
    }
  }, [oldFile, newFile, onSaveHistory, onStartCompare]);

  // ---- 使用演示数据继续（降级） ----
  const handleUseFallback = useCallback(() => {
    if (!oldFile || !newFile) return;
    const result: PolicyDiffResult = {
      ...mockDiffResult,
      document: {
        name: oldFile.name.replace(/\.[^.]+$/, ''),
        oldVersion: oldFile.version || '旧版',
        newVersion: newFile.version || '新版',
      },
    };
    const record: ComparisonHistoryRecord = {
      id: `cmp_${Date.now()}`,
      docName: result.document.name,
      oldVersion: result.document.oldVersion,
      newVersion: result.document.newVersion,
      oldFile: oldFile.name,
      newFile: newFile.name,
      createdAt: new Date().toISOString(),
      summary: result.summary,
      diffSnapshot: result,
    };
    onSaveHistory(record);
    setAnalyzing(false);
    onStartCompare(result, oldFile, newFile);
  }, [oldFile, newFile, onSaveHistory, onStartCompare]);

  // ---- 重新对比（回到确认状态） ----
  const handleRetry = useCallback(() => {
    setAnalyzing(false);
    setAnalyzeStep(0);
    setAnalyzeStatus('running');
    setAnalyzeErrorMsg('');
    setConfirmMode(true);
  }, []);

  // ---- 取消分析（回到确认状态） ----
  const handleCancel = useCallback(() => {
    setAnalyzing(false);
    setAnalyzeStep(0);
    setAnalyzeStatus('running');
    setConfirmMode(true);
  }, []);

  // ---- 调试：注入 JSON 并直接进入 Diff 页 ----
  const handleDebugInject = useCallback(() => {
    try {
      const parsed = JSON.parse(debugJson);
      if (!parsed || typeof parsed !== 'object') throw new Error('JSON 必须是对象');
      // 用 adaptDiffResult 的解析逻辑验证结构
      const result = tryParsePolicyDiffResult(parsed);
      if (!result) throw new Error('无法解析为 PolicyDiffResult，请检查是否包含 document 和 changes 字段');
      // 保存历史记录
      const record: ComparisonHistoryRecord = {
        id: `cmp_debug_${Date.now()}`,
        docName: result.document.name,
        oldVersion: result.document.oldVersion,
        newVersion: result.document.newVersion,
        oldFile: `${result.document.name}_${result.document.oldVersion}`,
        newFile: `${result.document.name}_${result.document.newVersion}`,
        createdAt: new Date().toISOString(),
        summary: result.summary,
        diffSnapshot: result,
      };
      onSaveHistory(record);
      const oldF: SelectedPolicyFile = {
        name: record.oldFile!,
        version: result.document.oldVersion,
        source: 'knowledge',
      };
      const newF: SelectedPolicyFile = {
        name: record.newFile!,
        version: result.document.newVersion,
        source: 'knowledge',
      };
      setDebugOpen(false);
      setDebugJson('');
      setDebugError(null);
      onStartCompare(result, oldF, newF);
    } catch (err) {
      setDebugError(err instanceof Error ? err.message : 'JSON 解析失败');
    }
  }, [debugJson, onSaveHistory, onStartCompare]);

  // ---- 从历史记录恢复 ----
  const handleHistoryClick = useCallback(
    (record: ComparisonHistoryRecord) => {
      const oldF: SelectedPolicyFile = {
        name: record.oldFile || record.docName,
        version: record.oldVersion,
        source: 'knowledge',
      };
      const newF: SelectedPolicyFile = {
        name: record.newFile || record.docName,
        version: record.newVersion,
        source: 'knowledge',
      };
      // 优先用保存的完整快照，没有则回退 mock
      const result: PolicyDiffResult = record.diffSnapshot ?? {
        ...mockDiffResult,
        document: { name: record.docName, oldVersion: record.oldVersion, newVersion: record.newVersion },
        summary: record.summary || mockDiffResult.summary,
      };
      onStartCompare(result, oldF, newF);
    },
    [onStartCompare]
  );

  // ============ 子组件：文件选择卡片 ============
  const FileCard = ({ side, file }: { side: 'old' | 'new'; file: SelectedPolicyFile | null }) => {
    const label = side === 'old' ? '旧政策' : '新政策';
    const sub = side === 'old' ? '选择作为基准的政策版本' : '选择需要与旧版本比较的政策版本';

    return (
      <div className={`pc-filecard pc-filecard--${side} ${file ? 'pc-filecard--filled' : ''}`}>
        <div className='pc-filecard__label'>
          <span className='pc-filecard__label-text'>{label}</span>
          <span className='pc-filecard__label-sub'>{sub}</span>
        </div>

        {file ? (
          <div className='pc-filecard__info'>
            <div className='pc-filecard__name'>《{file.name}》</div>
            <div className='pc-filecard__meta'>
              {file.version && <span className='pc-filecard__version'>{file.version}</span>}
              {file.type && <span className='pc-filecard__type'>{file.type}</span>}
              {file.size && <span className='pc-filecard__size'>{formatSize(file.size)}</span>}
              <span className='pc-filecard__checked'>✓ 已选择</span>
            </div>
            <button type='button' className='pc-filecard__clear' onClick={() => handleClear(side)}>
              更换
            </button>
          </div>
        ) : (
          <div className='pc-filecard__actions'>
            <button type='button' className='pc-btn pc-btn--outline' onClick={() => handleUpload(side)}>
              上传政策文件
            </button>
            <button type='button' className='pc-btn pc-btn--ghost' onClick={() => setKbPickerFor(side)}>
              从规则库选择
            </button>
          </div>
        )}
      </div>
    );
  };

  // ============ 渲染 ============
  return (
    <div className='pc-entry'>
      {/* 顶部 */}
      <header className='pc-entry__header'>
        <div className='pc-entry__header-left'>
          <button type='button' className='pc-back' onClick={() => navigate('/home')}>
            ← 返回
          </button>
          <div className='pc-entry__titles'>
            <h1 className='pc-entry__title'>政策对比</h1>
            <p className='pc-entry__subtitle'>发现两个政策版本之间的重要变化</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            type='button'
            className='pc-btn pc-btn--ghost pc-home-btn'
            onClick={() => navigate('/')}
            title='返回首页'
          >
            <Home size={15} theme='outline' fill='currentColor' />
          </button>
          <button
            type='button'
            className='pc-btn pc-btn--ghost pc-debug-btn'
            onClick={() => setDebugOpen(true)}
            title='Ctrl+Shift+D'
          >
            调试
          </button>
          <button type='button' className='pc-btn pc-btn--primary pc-btn--large' onClick={onOpenHistory}>
            历史对照 →
          </button>
        </div>
      </header>

      <div className='pc-entry__body'>
        {/* 新建对比 */}
        <section className='pc-entry__section'>
          <h2 className='pc-entry__section-title'>新建政策对比</h2>

          <div className='pc-entry__files'>
            <FileCard side='old' file={oldFile} />

            <div className='pc-entry__swap'>
              <button type='button' className='pc-swap-btn' onClick={handleSwap} disabled={!bothReady} title='交换版本'>
                ⇄
              </button>
              <span className='pc-swap-label'>交换版本</span>
            </div>

            <FileCard side='new' file={newFile} />
          </div>

          {/* 确认状态 */}
          {confirmMode && bothReady && !analyzing && (
            <div className='pc-confirm'>
              <div className='pc-confirm__title'>确认政策版本</div>
              <div className='pc-confirm__row'>
                <div className='pc-confirm__item'>
                  <span className='pc-confirm__item-label'>旧政策</span>
                  <span className='pc-confirm__item-name'>《{oldFile!.name}》</span>
                  <span className='pc-confirm__item-ver'>{oldFile!.version || '旧版'}</span>
                  <span className='pc-confirm__item-ready'>✓ 已准备</span>
                </div>
                <span className='pc-confirm__arrow'>→</span>
                <div className='pc-confirm__item'>
                  <span className='pc-confirm__item-label'>新政策</span>
                  <span className='pc-confirm__item-name'>《{newFile!.name}》</span>
                  <span className='pc-confirm__item-ver'>{newFile!.version || '新版'}</span>
                  <span className='pc-confirm__item-ready'>✓ 已准备</span>
                </div>
              </div>
              <div className='pc-confirm__actions'>
                <button type='button' className='pc-btn pc-btn--ghost' onClick={() => setConfirmMode(false)}>
                  返回修改
                </button>
                <button
                  type='button'
                  className='pc-btn pc-btn--primary'
                  onClick={handleConfirmStart}
                  disabled={mcpAvailable === false}
                >
                  {mcpAvailable === false ? 'MCP 未配置' : '开始政策对比'}
                </button>
              </div>
              {mcpAvailable === false && (
                <div className='pc-confirm__mcp-hint'>
                  ⚠ 未检测到可用的 MCP 服务器，点击后将使用演示数据。可在设置中配置政策对比 MCP 工具。
                </div>
              )}
            </div>
          )}

          {/* 分析中 / 分析结果 */}
          {analyzing && (
            <div className='pc-analyzing'>
              {analyzeStatus === 'running' && (
                <>
                  <div className='pc-analyzing__title'>正在分析政策变化</div>
                  <div className='pc-analyzing__steps'>
                    {['解析旧政策', '解析新政策', '建立条例对应关系', '识别修改、新增和删除'].map((step, i) => (
                      <div
                        key={i}
                        className={`pc-analyzing__step ${i < analyzeStep ? 'pc-analyzing__step--done' : i === analyzeStep ? 'pc-analyzing__step--active' : ''}`}
                      >
                        <span className='pc-analyzing__step-icon'>
                          {i < analyzeStep ? '✓' : i === analyzeStep ? '●' : '○'}
                        </span>
                        <span className='pc-analyzing__step-text'>{step}</span>
                      </div>
                    ))}
                  </div>
                  <button type='button' className='pc-btn pc-btn--ghost pc-analyzing__cancel' onClick={handleCancel}>
                    取消
                  </button>
                </>
              )}
              {analyzeStatus === 'success' && (
                <>
                  <div className='pc-analyzing__title pc-analyzing__title--success'>分析完成</div>
                  <div className='pc-analyzing__steps'>
                    {['解析旧政策', '解析新政策', '建立条例对应关系', '识别修改、新增和删除'].map((step, i) => (
                      <div key={i} className='pc-analyzing__step pc-analyzing__step--done'>
                        <span className='pc-analyzing__step-icon'>✓</span>
                        <span className='pc-analyzing__step-text'>{step}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {analyzeStatus === 'no_mcp' && (
                <div className='pc-analyzing__result pc-analyzing__result--warn'>
                  <div className='pc-analyzing__result-icon'>⚠</div>
                  <div className='pc-analyzing__result-title'>未检测到可用的 MCP 服务器</div>
                  <div className='pc-analyzing__result-desc'>
                    请先在设置中配置政策对比 MCP 工具。配置完成后将自动使用真实分析结果。
                  </div>
                  <div className='pc-analyzing__result-actions'>
                    <button type='button' className='pc-btn pc-btn--primary pc-btn--secondary' onClick={handleRetry}>
                      重新对比
                    </button>
                    <button type='button' className='pc-btn pc-btn--primary' onClick={handleUseFallback}>
                      使用演示数据继续
                    </button>
                  </div>
                </div>
              )}
              {analyzeStatus === 'timeout' && (
                <div className='pc-analyzing__result pc-analyzing__result--warn'>
                  <div className='pc-analyzing__result-icon'>⏱</div>
                  <div className='pc-analyzing__result-title'>MCP 调用超时</div>
                  <div className='pc-analyzing__result-desc'>
                    未在 30 秒内返回对比结果，可能是工具调用较慢或政策文件过大。MCP 正常后将自动使用真实结果。
                  </div>
                  <div className='pc-analyzing__result-actions'>
                    <button type='button' className='pc-btn pc-btn--primary pc-btn--secondary' onClick={handleRetry}>
                      重新对比
                    </button>
                    <button type='button' className='pc-btn pc-btn--primary' onClick={handleUseFallback}>
                      使用演示数据继续
                    </button>
                  </div>
                </div>
              )}
              {analyzeStatus === 'parse_failed' && (
                <div className='pc-analyzing__result pc-analyzing__result--warn'>
                  <div className='pc-analyzing__result-icon'>⚠</div>
                  <div className='pc-analyzing__result-title'>MCP 返回格式无法解析</div>
                  <div className='pc-analyzing__result-desc'>
                    MCP 返回了结果但结构不符合预期，请检查返回的 JSON 是否包含 document 和 changes 字段。
                  </div>
                  <div className='pc-analyzing__result-actions'>
                    <button type='button' className='pc-btn pc-btn--primary pc-btn--secondary' onClick={handleRetry}>
                      重新对比
                    </button>
                    <button type='button' className='pc-btn pc-btn--primary' onClick={handleUseFallback}>
                      使用演示数据继续
                    </button>
                  </div>
                </div>
              )}
              {analyzeStatus === 'error' && (
                <div className='pc-analyzing__result pc-analyzing__result--error'>
                  <div className='pc-analyzing__result-icon'>✕</div>
                  <div className='pc-analyzing__result-title'>MCP 调用失败</div>
                  <div className='pc-analyzing__result-desc'>{analyzeErrorMsg || '未知错误'}</div>
                  <div className='pc-analyzing__result-actions'>
                    <button type='button' className='pc-btn pc-btn--primary pc-btn--secondary' onClick={handleRetry}>
                      重新对比
                    </button>
                    <button type='button' className='pc-btn pc-btn--primary' onClick={handleUseFallback}>
                      使用演示数据继续
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 错误 */}
          {error && (
            <div className='pc-error'>
              <p>{error}</p>
              <button type='button' className='pc-btn pc-btn--primary' onClick={handleConfirmStart}>
                重新分析
              </button>
            </div>
          )}

          {/* 开始按钮（非确认模式时） */}
          {!confirmMode && !analyzing && !error && (
            <div className='pc-entry__start'>
              <button
                type='button'
                className='pc-btn pc-btn--primary pc-btn--large'
                onClick={handleStart}
                disabled={!bothReady}
              >
                开始政策对比
              </button>
              {!bothReady && <p className='pc-entry__start-hint'>请先选择旧政策和新政策文件</p>}
            </div>
          )}
        </section>

        {/* 历史对照 */}
        <section className='pc-entry__section' id='pc-history-section'>
          <div className='pc-entry__section-head'>
            <h2 className='pc-entry__section-title'>最近对照</h2>
            <span className='pc-entry__section-count'>{history.length} 条记录</span>
          </div>

          {history.length === 0 ? (
            <div className='pc-entry__empty'>
              <p className='pc-entry__empty-title'>还没有政策对照记录</p>
              <p className='pc-entry__empty-sub'>选择两个政策文件，开始第一次政策对比。</p>
            </div>
          ) : (
            <div className='pc-history-list'>
              {history.slice(0, 4).map((record) => (
                <div key={record.id} className='pc-history-item' onClick={() => handleHistoryClick(record)}>
                  <div className='pc-history-item__main'>
                    <div className='pc-history-item__name'>《{record.docName}》</div>
                    <div className='pc-history-item__versions'>
                      <span className='pc-history-item__ver'>{record.oldVersion}</span>
                      <span className='pc-history-item__arrow'>→</span>
                      <span className='pc-history-item__ver pc-history-item__ver--new'>{record.newVersion}</span>
                    </div>
                  </div>
                  <div className='pc-history-item__meta'>
                    {record.summary && (
                      <div className='pc-history-item__stats'>
                        <span>{record.summary.total} 处变化</span>
                        <span className='pc-history-item__detail'>
                          修改 {record.summary.modified} · 新增 {record.summary.added} · 删除 {record.summary.removed}
                        </span>
                      </div>
                    )}
                    <span className='pc-history-item__time'>
                      {new Date(record.createdAt).toLocaleString('zh-CN', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <span className='pc-history-item__action'>查看对照 →</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* 调试：JSON 注入弹窗 */}
      {debugOpen && (
        <div className='pc-debug-overlay' onClick={() => setDebugOpen(false)}>
          <div className='pc-debug-modal' onClick={(e) => e.stopPropagation()}>
            <div className='pc-debug__head'>
              <span className='pc-debug__title'>调试：注入 MCP 结果 JSON</span>
              <button type='button' className='pc-debug__close' onClick={() => setDebugOpen(false)}>
                ×
              </button>
            </div>
            <p className='pc-debug__desc'>
              粘贴政策对比 MCP 返回的 JSON，直接渲染 Diff 页面（Ctrl+Shift+D 开关此面板）。
            </p>
            <textarea
              className='pc-debug__textarea'
              placeholder='{"document": {"name": "...", "oldVersion": "2025版", "newVersion": "2026版"}, "changes": [...]}'
              value={debugJson}
              onChange={(e) => setDebugJson(e.target.value)}
              spellCheck={false}
            />
            {debugError && <div className='pc-debug__error'>{debugError}</div>}
            <div className='pc-debug__actions'>
              <button type='button' className='pc-btn pc-btn--ghost' onClick={() => setDebugOpen(false)}>
                取消
              </button>
              <button type='button' className='pc-btn pc-btn--primary' onClick={handleDebugInject}>
                注入并渲染
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 知识库选择弹窗 */}
      {kbPickerFor && (
        <div className='pc-kb-overlay' onClick={() => setKbPickerFor(null)}>
          <div className='pc-kb-modal' onClick={(e) => e.stopPropagation()}>
            <div className='pc-kb__head'>
              <span className='pc-kb__title'>从规则库选择</span>
              <button type='button' className='pc-kb__close' onClick={() => setKbPickerFor(null)}>
                ×
              </button>
            </div>
            <div className='pc-kb__list'>
              {kbDocs.length === 0 ? (
                <div className='pc-kb__empty'>规则库暂无文件，请先上传政策文件</div>
              ) : (
                kbDocs.map((doc) => (
                  <div key={doc.id} className='pc-kb__item' onClick={() => handleKbSelect(doc)}>
                    <span className='pc-kb__item-name'>{doc.title}</span>
                    <span className='pc-kb__item-meta'>
                      {doc.category && <span className='pc-kb__item-cat'>{doc.category}</span>}
                      {doc.year && <span className='pc-kb__item-year'>{doc.year}版</span>}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PolicyEntryView;
