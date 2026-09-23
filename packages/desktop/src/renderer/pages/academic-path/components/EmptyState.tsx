import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ipcBridge } from '@/common';
import { parsingSteps } from '../constants';

type SelectedFile = {
  name: string;
  path: string;
};

interface Props {
  onUpload: (fileName: string) => void;
  recentPlanName?: string;
  onUseRecentPlan?: () => void;
  /** 调试注入：直接传入 MCP 格式 JSON，跳过真实调用 */
  onDebugInject: (json: object) => void;
  /** 解析失败信息 */
  parseError?: { code: string; message: string } | null;
  hasHistory: boolean;
  onViewHistory: () => void;
  onBack: () => void;
}

const EmptyState: React.FC<Props> = ({ onUpload, onDebugInject, parseError, hasHistory, onViewHistory, onBack }) => {
  const [dragging, setDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const [parsing, setParsing] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [parseStep, setParseStep] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // ---- 调试：JSON 注入 ----
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugJson, setDebugJson] = useState('');
  const [debugError, setDebugError] = useState<string | null>(null);

  const handleFile = useCallback(async () => {
    try {
      const files = await ipcBridge.dialog.showOpen.invoke({
        properties: ['openFile'],
        filters: [{ name: '培养方案', extensions: ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png'] }],
      });
      if (files && files.length > 0) {
        const path = files[0];
        const name = path.split(/[\\/]/).pop() || path;
        setSelectedFile({ name, path });
      }
    } catch {
      /* ignore */
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      const path = window.electronAPI?.getPathForFile(file);
      if (path) setSelectedFile({ name: file.name, path });
    }
  }, []);

  // 开始分析 → 内联显示解析动画，同时通知父组件调用 MCP
  const handleStart = useCallback(() => {
    if (!selectedFile) return;
    setParsing(true);
    setParseStep(0);
    onUpload(selectedFile.path);
  }, [selectedFile, onUpload]);

  // 解析步骤动画
  useEffect(() => {
    if (!parsing || parseError) return;
    if (parseStep >= parsingSteps.length) {
      return;
    }
    const t = setTimeout(() => setParseStep((s) => s + 1), 700);
    return () => clearTimeout(t);
  }, [parsing, parseStep, parseError]);

  // 等待秒数计时
  useEffect(() => {
    if (!parsing) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [parsing]);

  // 取消解析
  const handleCancel = useCallback(() => {
    setParsing(false);
    setParseStep(0);
    setSelectedFile(null);
  }, []);

  // ---- 调试：Ctrl+Shift+D 开关注入面板 ----
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

  // ---- 调试：注入 JSON 并直接进入确认页 ----
  const handleDebugInject = useCallback(() => {
    try {
      const parsed = JSON.parse(debugJson);
      if (!parsed || typeof parsed !== 'object') throw new Error('JSON 必须是对象');
      if (!parsed.major || !Array.isArray(parsed.courses) || parsed.courses.length === 0) {
        throw new Error('缺少 major 或 courses 字段');
      }
      onDebugInject(parsed);
      setDebugOpen(false);
      setDebugJson('');
      setDebugError(null);
    } catch (err) {
      setDebugError(err instanceof Error ? err.message : 'JSON 解析失败');
    }
  }, [debugJson, onDebugInject]);

  // 解析失败 → 显示失败状态
  if (parsing && parseError) {
    return (
      <div className='ap-empty'>
        <header className='ap-empty__header'>
          <button type='button' className='ap-back' onClick={onBack}>
            ← 返回
          </button>
          {hasHistory && (
            <button type='button' className='ap-btn ap-btn--primary' onClick={onViewHistory}>
              培养方案历史
            </button>
          )}
        </header>
        <div className='ap-empty__inner'>
          <div className='ap-empty__icon'>🎓</div>
          <h1 className='ap-empty__title'>建立你的学业路径</h1>
          <div className='ap-empty__parse-card ap-empty__parse-card--failed'>
            <div className='ap-parsing__failed-icon'>✕</div>
            <h2 className='ap-parsing__title'>解析失败</h2>
            <p className='ap-parsing__failed-msg'>{parseError.message}</p>
            {parseError.code && <p className='ap-parsing__failed-code'>错误代码：{parseError.code}</p>}
            <div className='ap-parsing__failed-actions'>
              <button type='button' className='ap-btn ap-btn--primary ap-btn--large' onClick={handleCancel}>
                重新上传
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 解析中 → 内联显示解析动画（替换上传卡片）
  if (parsing) {
    return (
      <div className='ap-empty'>
        <header className='ap-empty__header'>
          <button type='button' className='ap-back' onClick={onBack}>
            ← 返回
          </button>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button
              type='button'
              className='ap-btn ap-btn--ghost ap-debug-btn'
              onClick={() => setDebugOpen(true)}
              title='Ctrl+Shift+D'
            >
              调试
            </button>
            {hasHistory && (
              <button type='button' className='ap-btn ap-btn--primary' onClick={onViewHistory}>
                培养方案历史
              </button>
            )}
          </div>
        </header>
        <div className='ap-empty__inner'>
          <div className='ap-empty__icon'>🎓</div>
          <h1 className='ap-empty__title'>建立你的学业路径</h1>
          <div className='ap-empty__parse-card'>
            <div className='ap-parsing__spinner' />
            <h2 className='ap-parsing__title'>正在理解你的培养方案……</h2>
            <div className='ap-empty__parse-filename'>{selectedFile.name}</div>
            <div className='ap-parsing__steps'>
              {parsingSteps.map((s, i) => (
                <div
                  key={s}
                  className={`ap-parsing__step ${i < parseStep ? 'ap-parsing__step--done' : i === parseStep ? 'ap-parsing__step--active' : ''}`}
                >
                  <span className='ap-parsing__step-icon'>{i < parseStep ? '✓' : i === parseStep ? '●' : '○'}</span>
                  <span className='ap-parsing__step-text'>{s}</span>
                </div>
              ))}
            </div>

        <p className='ap-parsing__wait-hint'>
          {elapsed < 15
            ? 'AI 正在分析，请耐心等待…'
            : elapsed < 45
            ? `已等待 ${elapsed} 秒，AI 正在深度分析，预计还需 30-60 秒`
            : `已等待 ${elapsed} 秒，分析时间较长，请耐心等待，不要关闭页面`}
        </p>
            <button type='button' className='ap-btn ap-btn--ghost ap-empty__parse-cancel' onClick={handleCancel}>
              取消
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 默认：上传状态
  return (
    <div className='ap-empty'>
      {/* 装饰性背景：淡灰色课程节点连线 */}
      <header className='ap-empty__header'>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            type='button'
            className='ap-btn ap-btn--ghost ap-debug-btn'
            onClick={() => setDebugOpen(true)}
            title='Ctrl+Shift+D'
          >
            调试
          </button>
        </div>
      </header>

      <div className='ap-empty__inner'>
        <div className='ap-empty__icon'>🎓</div>
        <h1 className='ap-empty__title'>建立你的学业路径</h1>
        <p className='ap-empty__desc'>
          上传你的专业培养方案，AI 将自动识别课程、学分、培养要求和课程先修关系，为你生成个人学业地图。
        </p>

        <div
          className={`ap-empty__dropzone ${dragging ? 'ap-empty__dropzone--dragging' : ''} ${selectedFile ? 'ap-empty__dropzone--filled' : ''}`}
          onClick={handleFile}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          <input
            ref={inputRef}
            type='file'
            accept='.pdf,.doc,.docx,.jpg,.jpeg,.png'
            style={{ display: 'none' }}
            onChange={handleFile}
          />
          {selectedFile ? (
            <>
              <div className='ap-empty__dropzone-icon'>✓</div>
              <div className='ap-empty__dropzone-title'>{selectedFile.name}</div>
              <div className='ap-empty__dropzone-sub'>已选择，点击可重新选择</div>
            </>
          ) : (
            <>
              <div className='ap-empty__dropzone-icon'>📄</div>
              <div className='ap-empty__dropzone-title'>上传培养方案</div>
              <div className='ap-empty__dropzone-sub'>点击或拖拽文件到此处</div>
              <div className='ap-empty__dropzone-formats'>支持 PDF / Word / 图片</div>
            </>
          )}
        </div>

        <div
          className='ap-empty__start-wrap'
          style={{ display: 'flex', gap: '12px', justifyContent: 'center', alignItems: 'center' }}
        >
          {selectedFile && (
            <button type='button' className='ap-btn ap-btn--ghost' onClick={() => setSelectedFile(null)}>
              取消选择
            </button>
          )}
          <button
            type='button'
            className={`ap-btn ap-btn--primary ap-btn--large ap-empty__start-btn ${!selectedFile ? 'ap-btn--disabled' : ''}`}
            disabled={!selectedFile}
            onClick={handleStart}
          >
            开始分析
          </button>
        </div>
      </div>

      {/* 调试：JSON 注入弹窗 */}
      {debugOpen && (
        <div className='ap-debug-overlay' onClick={() => setDebugOpen(false)}>
          <div className='ap-debug-modal' onClick={(e) => e.stopPropagation()}>
            <div className='ap-debug__head'>
              <span className='ap-debug__title'>调试：注入培养方案 JSON</span>
              <button type='button' className='ap-debug__close' onClick={() => setDebugOpen(false)}>
                ×
              </button>
            </div>
            <p className='ap-debug__desc'>粘贴 MCP 返回的培养方案 JSON，直接进入确认页（Ctrl+Shift+D 开关此面板）。</p>
            <textarea
              className='ap-debug__textarea'
              placeholder='{"major": "软件工程", "grade": "2024", "courses": [...]}'
              value={debugJson}
              onChange={(e) => setDebugJson(e.target.value)}
              spellCheck={false}
            />
            {debugError && <div className='ap-debug__error'>{debugError}</div>}
            <div className='ap-debug__actions'>
              <button type='button' className='ap-btn ap-btn--ghost' onClick={() => setDebugOpen(false)}>
                取消
              </button>
              <button type='button' className='ap-btn ap-btn--primary' onClick={handleDebugInject}>
                注入并确认
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EmptyState;
