import React, { useState } from 'react';
import EntryView from './views/EntryView';
import ReportView from './views/ReportView';
import HistoryScanView from './views/HistoryScanView';
import type { ContractType, ContractReport } from './types';
import { checkMcpAvailable, sendScanRequest, pollScanResult, resetConversation } from './contractScanClient';

const ContractScanPage: React.FC = () => {
  const [contractText, setContractText] = useState('');
  const [contractType, setContractType] = useState<ContractType>('auto');
  const [uploadedFile, setUploadedFile] = useState<{ name: string; size: number } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<'no_mcp' | 'timeout' | 'parse_failed' | 'error' | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [viewingReport, setViewingReport] = useState<ContractReport | null>(null);
  const [report, setReport] = useState<ContractReport | null>(null);

  const isValid = contractText.trim().length >= 50;

  const handleStartScan = async () => {
    if (!isValid || scanning) return;
    setScanError(null);
    setScanning(true);

    try {
      // 1. 检查 MCP 是否可用
      const mcpAvailable = await checkMcpAvailable();
      if (!mcpAvailable) {
        setScanError('no_mcp');
        setScanning(false);
        return;
      }

      // 2. 发送扫描请求
      await sendScanRequest(contractText, contractType);

      // 3. 轮询获取结果
      const result = await pollScanResult(null, (status) => {
        if (status === 'timeout') {
          setScanError('timeout');
          setScanning(false);
        }
      });

      // 4. 成功，显示报告
      setScanning(false);
      setReport(result);
      saveToHistory(result);
    } catch (e: any) {
      setScanning(false);
      if (e?.message?.includes('超时')) {
        setScanError('timeout');
      } else if (e?.message?.includes('解析')) {
        setScanError('parse_failed');
      } else {
        setScanError('error');
      }
    }
  };

  // 调试注入
  const handleDebugInject = (debugReport: ContractReport) => {
    setReport(debugReport);
    saveToHistory(debugReport);
  };

  const handleRescan = () => {
    resetConversation();
    setReport(null);
    setViewingReport(null);
    setScanning(false);
    setScanError(null);
    setShowHistory(false);
  };

  const handleCancelScan = () => {
    setScanning(false);
    setScanError(null);
  };

  // 保存到历史记录
  const saveToHistory = (report: ContractReport) => {
    const historyKey = 'contract-scan-history:v1';
    const saved = localStorage.getItem(historyKey);
    const history = saved ? JSON.parse(saved) : [];
    const newRecord = {
      id: Date.now().toString(),
      timestamp: Date.now(),
      fileName: report.meta.title,
      contractType: String(report.meta.contractType),
      score: report.score,
      grade: report.grade,
      summary: report.summary,
      report: report,
    };
    history.unshift(newRecord);
    localStorage.setItem(historyKey, JSON.stringify(history));
  };

  // 查看历史报告
  const handleViewHistoryReport = (record: any) => {
    setViewingReport(record.report);
    setShowHistory(false);
  };

  const handleFileUpload = (name: string, size: number) => {
    setUploadedFile({ name, size });
  };

  const handleRemoveFile = () => {
    setUploadedFile(null);
  };

  // 历史扫描状态
  if (showHistory) {
    return (
      <HistoryScanView
        onBack={() => setShowHistory(false)}
        onViewReport={handleViewHistoryReport}
      />
    );
  }

  // 查看历史报告状态
  if (viewingReport) {
    return (
      <ReportView
        report={viewingReport}
        onRescan={handleRescan}
        onShowHistory={() => setShowHistory(true)}
      />
    );
  }

  // 报告状态
  if (report) {
    return (
      <ReportView
        report={report}
        onRescan={handleRescan}
        onShowHistory={() => setShowHistory(true)}
      />
    );
  }

  return (
    <EntryView
      contractText={contractText}
      setContractText={setContractText}
      contractType={contractType}
      setContractType={setContractType}
      uploadedFile={uploadedFile}
      onFileUpload={handleFileUpload}
      onRemoveFile={handleRemoveFile}
      isValid={isValid}
      scanning={scanning}
      scanError={scanError}
      onStartScan={handleStartScan}
      onCancelScan={handleCancelScan}
      onShowHistory={() => setShowHistory(true)}
      onDebugInject={handleDebugInject}
    />
  );
};

export default ContractScanPage;
