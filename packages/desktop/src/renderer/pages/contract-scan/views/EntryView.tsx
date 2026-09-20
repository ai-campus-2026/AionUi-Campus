import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '../contract-scan.css';
import type { ContractType } from '../types';
import { tryParseContractScanResult } from '../adaptContractScanResult';

interface EntryViewProps {
  contractText: string;
  setContractText: (text: string) => void;
  contractType: ContractType;
  setContractType: (type: ContractType) => void;
  uploadedFile: { name: string; size: number } | null;
  onFileUpload: (name: string, size: number) => void;
  onRemoveFile: () => void;
  isValid: boolean;
  scanning: boolean;
  scanError: 'no_mcp' | 'timeout' | 'parse_failed' | 'error' | null;
  onStartScan: () => void;
  onCancelScan: () => void;
  onShowHistory: () => void;
  onDebugInject?: (report: any) => void;
}

const CONTRACT_TYPES: Array<{ value: ContractType; label: string }> = [
  { value: 'auto', label: '自动识别' },
  { value: 'rental', label: '租房' },
  { value: 'internship', label: '实习' },
  { value: 'labor', label: '劳动' },
  { value: 'nda', label: 'NDA' },
];

const SCAN_STEPS = [
  { key: 'parse', label: '合同结构解析', hint: '正在识别合同中的关键条款……' },
  { key: 'reg', label: '法规规则核查', hint: '正在核查相关法规……' },
  { key: 'ai', label: 'AI 风险分析', hint: '正在寻找潜在风险……' },
  { key: 'report', label: '整理分析报告', hint: '正在整理分析结果……' },
];

const EntryView: React.FC<EntryViewProps> = ({
  contractText,
  setContractText,
  contractType,
  setContractType,
  uploadedFile,
  onFileUpload,
  onRemoveFile,
  isValid,
  scanning,
  scanError,
  onStartScan,
  onCancelScan,
  onShowHistory,
  onDebugInject,
}) => {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [scanStep, setScanStep] = useState(0);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  
  // 调试状态
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugJson, setDebugJson] = useState('');
  const [debugError, setDebugError] = useState<string | null>(null);

  const charCount = contractText.length;
  const tooShort = charCount > 0 && charCount < 50;

  // 模拟扫描步骤推进
  React.useEffect(() => {
    if (!scanning) {
      setScanStep(0);
      return;
    }
    if (scanStep >= SCAN_STEPS.length - 1) return;
    const t = setTimeout(() => setScanStep((s) => s + 1), 1500);
    return () => clearTimeout(t);
  }, [scanning, scanStep]);

  // 调试：注入 JSON
  const handleDebugInject = () => {
    try {
      const parsed = JSON.parse(debugJson);
      const report = tryParseContractScanResult(parsed);
      if (!report) {
        setDebugError('无法解析 JSON，请检查格式');
        return;
      }
      onDebugInject?.(report);
      setDebugOpen(false);
      setDebugJson('');
      setDebugError(null);
    } catch (e: any) {
      setDebugError(`JSON 解析错误: ${e.message}`);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    onFileUpload(file.name, file.size);
    const reader = new FileReader();
    reader.onload = () => {
      setContractText(String(reader.result || ''));
    };
    reader.readAsText(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => {
    setDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    onFileUpload(file.name, file.size);
    const reader = new FileReader();
    reader.onload = () => {
      setContractText(String(reader.result || ''));
    };
    reader.readAsText(file);
  };

  const currentTypeName = CONTRACT_TYPES.find((t) => t.value === contractType)?.label ?? '自动识别';

  return (
    <div className={'cs-entry'}>
      {/* 背景装饰 */}
      <div className={'cs-entry__bg-glow cs-entry__bg-glow--1'} />
      <div className={'cs-entry__bg-glow cs-entry__bg-glow--2'} />

      {/* 顶部导航 */}
      <header className={'cs-entry__header'}>
        <div className={'cs-entry__header-left'}>
          <button className={'cs-entry__back-btn'} onClick={() => navigate('/home')}>
            ← 返回
          </button>
          <div className={'cs-entry__header-titles'}>
            <h1 className={'cs-entry__page-title'}>合同扫描</h1>
            <p className={'cs-entry__page-subtitle'}>在签字之前，先看懂合同里的风险</p>
          </div>
        </div>
        <div className={'cs-entry__header-right'}>
          <button
            onClick={() => setDebugOpen(true)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              padding: '6px 14px',
              fontSize: '12.5px',
              fontWeight: 500,
              borderRadius: '9px',
              cursor: 'pointer',
              border: '1px solid rgba(0, 0, 0, 0.08)',
              background: 'rgba(255, 255, 255, 0.6)',
              color: '#555',
              marginRight: '8px',
            }}
          >
            调试
          </button>
          <button 
            onClick={onShowHistory}
            style={{
              color: '#fff',
              background: 'linear-gradient(135deg, #7f9d78, #648b80)',
              border: 'none',
              borderRadius: '9px',
              padding: '6px 14px',
              fontSize: '12.5px',
              fontWeight: 500,
              cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(70, 100, 84, 0.2)',
            }}
          >
            历史扫描
          </button>
        </div>
      </header>

      {/* 主体内容 */}
      <main className={'cs-entry__main'}>
        {/* 中心图标 - 扫描时隐藏 */}
        {!scanning && (
          <div className={'cs-entry__hero'}>
            <div className={'cs-entry__hero-icon'}>
              ✦
            </div>
          </div>
        )}

        {!scanning ? (
          <>
            <div className={'cs-entry__section-title'}>
              <span className={'cs-entry__section-bar'} />
              上传或粘贴合同
            </div>

            {/* 合同输入卡片 */}
            <div
              className={`cs-entry__card cs-entry__input-card ${focused ? 'cs-entry__card--focused' : ''} ${dragOver ? 'cs-entry__card--dragging' : ''}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <div className={'cs-entry__input-header'}>
                📄
                <span>粘贴合同全文</span>
              </div>
              <textarea
                className={'cs-entry__input'}
                placeholder='在这里粘贴你的合同内容……&#10;&#10;支持租房合同、实习协议、劳动合同、NDA 等各类法律文件'
                value={contractText}
                onChange={(e) => setContractText(e.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                rows={10}
              />

              <div className={'cs-entry__input-footer'}>
                <button
                  type="button"
                  className={'cs-entry__upload-btn'}
                  onClick={() => fileInputRef.current?.click()}
                >
                  ↑
                  上传文件
                </button>
                <div className={'cs-entry__footer-right'}>
                  {contractText && (
                    <button
                      type="button"
                      className={'cs-entry__clear-btn'}
                      onClick={() => setContractText('')}
                    >
                      清空
                    </button>
                  )}
                  <span className={'cs-entry__char-count'}>{charCount.toLocaleString()} 字</span>
                </div>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,.docx"
                onChange={handleFileUpload}
                style={{ display: 'none' }}
              />
            </div>

            {/* 上传文件卡片 */}
            {uploadedFile && (
              <div className={'cs-entry__card cs-entry__file-card'}>
                <span className={'cs-entry__file-icon'}>📄</span>
                <div className={'cs-entry__file-info'}>
                  <div className={'cs-entry__file-name'}>{uploadedFile.name}</div>
                  <div className={'cs-entry__file-size'}>{(uploadedFile.size / 1024).toFixed(1)} KB</div>
                </div>
                <button className={'cs-entry__file-remove'} onClick={onRemoveFile}>×</button>
              </div>
            )}

            {/* 输入过短提示 */}
            {tooShort && (
              <div className={'cs-entry__short-warning'}>
                合同内容过短，请粘贴完整合同。
              </div>
            )}

            {/* 合同类型选择 */}
            <div className={'cs-entry__type-section'}>
              <span className={'cs-entry__type-label'}>合同类型</span>
              <div className={'cs-entry__type-capsules'}>
                {CONTRACT_TYPES.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    className={`cs-entry__type-capsule ${contractType === t.value ? 'cs-entry__type-capsule--active' : ''}`}
                    onClick={() => setContractType(t.value)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 开始扫描按钮 */}
            <div className={'cs-entry__action-area'}>
              <button
                type="button"
                className={'cs-entry__scan-btn'}
                onClick={onStartScan}
                disabled={!isValid || scanning}
              >
                {scanning ? '分析中……' : '开始智能扫描 →'}
              </button>
              <p className={'cs-entry__privacy-note'}>
                合同内容将用于本次 AI 分析，请勿上传与分析无关的敏感信息。
              </p>
            </div>
          </>
        ) : (
          <>
            {/* 扫描状态 - 原地在同一个卡片里 */}
            <div className={'cs-entry__card cs-entry__scanning-card'}>
              {/* AI 核心 */}
              <div className={'cs-scan-core'}>
                <div className={'cs-scan-core-ring'} />
                <div className={'cs-scan-core-inner'}>
                  ✦
                </div>
              </div>

              <h3 className={'cs-scan-title'}>正在分析合同</h3>
              <p className={'cs-scan-subtitle'}>AI 正在逐项检查合同内容</p>

              {/* 扫描步骤 */}
              <div className={'cs-scan-steps'}>
                {SCAN_STEPS.map((step, i) => {
                  const status = i < scanStep ? 'completed' : i === scanStep ? 'running' : 'pending';
                  return (
                    <div key={step.key} className={`cs-scan-step cs-scan-step--${status}`}>
                      <span className={'cs-scan-step-icon'}>
                        {status === 'completed' ? '✓' : status === 'running' ? '◉' : '○'}
                      </span>
                      <span className={'cs-scan-step-label'}>{step.label}</span>
                    </div>
                  );
                })}
              </div>

              {/* 动态提示 */}
              <p className={'cs-scan-hint'}>{SCAN_STEPS[scanStep]?.hint}</p>

              {/* 文件信息 */}
              <div className={'cs-scan-file-info'}>
                {uploadedFile ? uploadedFile.name : '粘贴的合同内容'}
                <span className={'cs-scan-file-meta'}>
                  {uploadedFile ? `${(uploadedFile.size / 1024).toFixed(1)} KB · ` : ''}
                  {charCount.toLocaleString()} 字
                </span>
              </div>
            </div>

            {/* 合同类型显示 */}
            <div className={'cs-entry__type-display'}>
              合同类型：{currentTypeName}
            </div>

            {/* 取消扫描 */}
            <div className={'cs-entry__cancel-area'}>
              {showCancelConfirm ? (
                <div className={'cs-cancel-confirm'}>
                  <span>确定要停止本次扫描？</span>
                  <div className={'cs-cancel-actions'}>
                    <button
                      className={'cs-cancel-btn cs-cancel-btn--ghost'}
                      onClick={() => setShowCancelConfirm(false)}
                    >
                      继续分析
                    </button>
                    <button
                      className={'cs-cancel-btn cs-cancel-btn--danger'}
                      onClick={() => {
                        setShowCancelConfirm(false);
                        onCancelScan();
                      }}
                    >
                      停止扫描
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className={'cs-entry__cancel-btn'}
                  onClick={() => setShowCancelConfirm(true)}
                >
                  取消扫描
                </button>
              )}
            </div>
          </>
        )}
      </main>

      {/* 调试：JSON 注入弹窗 */}
      {debugOpen && (
        <div 
          className="cs-debug-overlay" 
          onClick={(e) => {
            // 只有点击 overlay 本身（不是 modal 内部）才关闭
            if (e.target === e.currentTarget) {
              setDebugOpen(false);
            }
          }}
        >
          <div className="cs-debug-modal">
            <div className="cs-debug__head">
              <span className="cs-debug__title">调试：注入 MCP 结果 JSON</span>
              <button type="button" className="cs-debug__close" onClick={() => setDebugOpen(false)}>×</button>
            </div>
            <p className="cs-debug__desc">
              粘贴 contract_scan MCP 返回的完整 JSON，直接生成报告。
            </p>
            <textarea
              className="cs-debug__textarea"
              placeholder='{"fairness_score": 72, "summary": "...", "red_flags": [...]}'
              value={debugJson}
              onChange={(e) => setDebugJson(e.target.value)}
              rows={12}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            />
            {debugError && <div className="cs-debug__error">{debugError}</div>}
            <div className="cs-debug__actions">
              <button type="button" className="cs-debug__cancel" onClick={() => setDebugOpen(false)}>
                取消
              </button>
              <button type="button" className="cs-debug__confirm" onClick={handleDebugInject}>
                注入并显示报告
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EntryView;
