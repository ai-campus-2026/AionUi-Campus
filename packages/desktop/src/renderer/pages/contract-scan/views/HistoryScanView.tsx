import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import '../contract-scan.css';
import type { ContractReport } from '../types';

interface HistoryRecord {
  id: string;
  timestamp: number;
  fileName: string;
  contractType: string;
  score: number;
  grade: string;
  summary: string;
  report: ContractReport;
}

interface HistoryScanViewProps {
  onBack: () => void;
  onViewReport: (record: HistoryRecord) => void;
}

const HistoryScanView: React.FC<HistoryScanViewProps> = ({ onBack, onViewReport }) => {
  const navigate = useNavigate();
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBatchMode, setIsBatchMode] = useState(false);

  // 加载历史记录
  useEffect(() => {
    const saved = localStorage.getItem('contract-scan-history:v1');
    if (saved) {
      try {
        setHistory(JSON.parse(saved));
      } catch (e) {
        console.error('Failed to load history:', e);
      }
    }
  }, []);

  // 保存历史记录
  const saveHistory = (newHistory: HistoryRecord[]) => {
    setHistory(newHistory);
    localStorage.setItem('contract-scan-history:v1', JSON.stringify(newHistory));
  };

  // 单条删除
  const handleDelete = (id: string) => {
    if (window.confirm('确定删除这条扫描记录吗？该操作不可恢复。')) {
      const newHistory = history.filter((r) => r.id !== id);
      saveHistory(newHistory);
      setSelectedIds(new Set([...selectedIds].filter((i) => i !== id)));
    }
  };

  // 批量删除
  const handleBatchDelete = () => {
    if (selectedIds.size === 0) return;
    if (window.confirm(`确定删除选中的 ${selectedIds.size} 条扫描记录吗？该操作不可恢复。`)) {
      const newHistory = history.filter((r) => !selectedIds.has(r.id));
      saveHistory(newHistory);
      setSelectedIds(new Set());
      setIsBatchMode(false);
    }
  };

  // 切换选中
  const toggleSelect = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  // 格式化时间
  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className={'cs-history'}>
      <div className={'cs-entry__bg-glow cs-entry__bg-glow--1'} />
      <div className={'cs-entry__bg-glow cs-entry__bg-glow--2'} />

      {/* 顶部导航 */}
      <header className={'cs-history__header'}>
        <button className={'cs-entry__back-btn'} onClick={onBack}>
          ← 返回
        </button>
        <div className={'cs-history__header-titles'}>
          <h1 className={'cs-history__page-title'}>历史扫描</h1>
          <p className={'cs-history__page-subtitle'}>共 {history.length} 条记录</p>
        </div>
        <div className={'cs-history__header-actions'}>
          {history.length > 0 && (
            <>
              {isBatchMode ? (
                <>
                  <button
                    className={'cs-history__batch-delete-btn'}
                    onClick={handleBatchDelete}
                    disabled={selectedIds.size === 0}
                  >
                    删除选中 ({selectedIds.size})
                  </button>
                  <button
                    className={'cs-history__cancel-batch-btn'}
                    onClick={() => {
                      setIsBatchMode(false);
                      setSelectedIds(new Set());
                    }}
                  >
                    取消
                  </button>
                </>
              ) : (
                <button
                  className={'cs-history__manage-btn'}
                  onClick={() => setIsBatchMode(true)}
                >
                  批量管理
                </button>
              )}
            </>
          )}
        </div>
      </header>

      {/* 主体内容 */}
      <main className={'cs-history__main'}>
        {history.length === 0 ? (
          <div className={'cs-history__empty'}>
            <div className={'cs-history__empty-icon'}>📄</div>
            <h3>还没有扫描记录</h3>
            <p>完成合同扫描后，记录会自动保存在这里</p>
            <button className={'cs-history__start-btn'} onClick={onBack}>
              开始扫描
            </button>
          </div>
        ) : (
          <div className={'cs-history__list'}>
            {history.map((record) => (
              <div
                key={record.id}
                className={`cs-history-item ${selectedIds.has(record.id) ? 'cs-history-item--selected' : ''}`}
                onClick={() => {
                  if (isBatchMode) {
                    toggleSelect(record.id);
                  } else {
                    onViewReport(record);
                  }
                }}
              >
                {/* 批量选择框 */}
                {isBatchMode && (
                  <div className={'cs-history-checkbox'}>
                    {selectedIds.has(record.id) && '✓'}
                  </div>
                )}

                <div className={'cs-history-item-content'}>
                  <div className={'cs-history-item-header'}>
                    <h4 className={'cs-history-item-title'}>《{record.fileName}》</h4>
                    <span className={'cs-history-item-score'}>{record.score} {record.grade}</span>
                  </div>
                  <p className={'cs-history-item-summary'}>{record.summary.slice(0, 80)}...</p>
                  <div className={'cs-history-item-meta'}>
                    <span>{record.contractType}</span>
                    <span>·</span>
                    <span>{formatTime(record.timestamp)}</span>
                  </div>
                </div>

                {/* 删除按钮 */}
                {!isBatchMode && (
                  <button
                    className={'cs-history-delete-btn'}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(record.id);
                    }}
                    title="删除此记录"
                  >
                    🗑
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
};

export default HistoryScanView;
