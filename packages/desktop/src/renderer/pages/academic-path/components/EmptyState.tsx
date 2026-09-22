import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Home } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { parsingSteps } from '../mockData';

interface Props {
  onUpload: (attachmentPath: string) => void;
  /** 调试注入：直接传入 MCP 格式 JSON，跳过真实调用 */
  onDebugInject: (json: object) => void;
  /** 解析失败信息 */
  parseError?: { code: string; message: string } | null;
  hasHistory: boolean;
  onViewHistory: () => void;
  onBack: () => void;
}

const EmptyState: React.FC<Props> = ({ onUpload, onDebugInject, parseError, hasHistory, onViewHistory, onBack }) => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseStep, setParseStep] = useState(0);
  // ---- 调试：JSON 注入 ----
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugJson, setDebugJson] = useState('');
  const [debugError, setDebugError] = useState<string | null>(null);

  const handleFile = useCallback(async () => {
    try {
      const files = await ipcBridge.dialog.showOpen.invoke({
        properties: ['openFile'],
        filters: [{ name: 'Curriculum', extensions: ['pdf'] }],
      });
      if (files && files.length > 0) {
        const path = files[0];
        const name = path.split(/[\\/]/).pop() || path;
        setSelectedFile(name);
        setSelectedPath(path);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Start a real import; a filename alone is never treated as an attachment.
  const handleStart = useCallback(() => {
    if (!selectedPath) return;
    setParsing(true);
    setParseStep(0);
    onUpload(selectedPath);
  }, [selectedPath, onUpload]);

  // 解析步骤动画
  useEffect(() => {
    if (!parsing || parseError) return;
    if (parseStep >= parsingSteps.length) {
      return;
    }
    const timer = setTimeout(() => setParseStep((s) => s + 1), 700);
    return () => clearTimeout(timer);
  }, [parsing, parseStep, parseError]);

  // 取消解析
  const handleCancel = useCallback(() => {
    setParsing(false);
    setParseStep(0);
    setSelectedFile(null);
    setSelectedPath(null);
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
            <div className='ap-empty__parse-filename'>{selectedFile}</div>
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
      <header className='ap-empty__header'>
        <button type='button' className='ap-back' onClick={onBack}>
          ← 返回
        </button>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            type='button'
            className='ap-btn ap-btn--ghost ap-home-btn'
            onClick={() => navigate('/')}
            title='返回首页'
          >
            <Home size={15} theme='outline' fill='currentColor' />
          </button>
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
        <p className='ap-empty__desc'>{t('mcp.curriculumUploadDescription')}</p>

        <div className={`ap-empty__dropzone ${selectedFile ? 'ap-empty__dropzone--filled' : ''}`} onClick={handleFile}>
          {selectedFile ? (
            <>
              <div className='ap-empty__dropzone-icon'>✓</div>
              <div className='ap-empty__dropzone-title'>{selectedFile}</div>
              <div className='ap-empty__dropzone-sub'>{t('mcp.curriculumChooseAnother')}</div>
            </>
          ) : (
            <>
              <div className='ap-empty__dropzone-icon'>📄</div>
              <div className='ap-empty__dropzone-title'>{t('mcp.curriculumChooseFile')}</div>
              <div className='ap-empty__dropzone-formats'>{t('mcp.curriculumSupportedFormats')}</div>
            </>
          )}
        </div>

        <div className='ap-empty__start-wrap'>
          <button
            type='button'
            className={`ap-btn ap-btn--primary ap-btn--large ap-empty__start-btn ${!selectedFile ? 'ap-btn--disabled' : ''}`}
            disabled={!selectedPath}
            onClick={handleStart}
          >
            {t('mcp.curriculumStoreButton')}
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
