import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcBridge } from '@/common';
import EmptyState from '@renderer/pages/academic-path/components/EmptyState';

vi.mock('@/common', () => ({
  ipcBridge: {
    dialog: {
      showOpen: { invoke: vi.fn() },
    },
  },
}));

const baseProps = {
  onUpload: vi.fn(),
  onDebugInject: vi.fn(),
  hasHistory: false,
  onViewHistory: vi.fn(),
  onBack: vi.fn(),
};

describe('academic path file selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { getPathForFile: vi.fn() },
    });
  });

  it('passes the absolute picker path to parsing while showing only the file name', async () => {
    vi.mocked(ipcBridge.dialog.showOpen.invoke).mockResolvedValue(['C:\\plans\\curriculum.pdf']);
    const onUpload = vi.fn();
    render(<EmptyState {...baseProps} onUpload={onUpload} />);

    fireEvent.click(screen.getByText('上传培养方案'));
    await screen.findByText('curriculum.pdf');
    fireEvent.click(screen.getByRole('button', { name: '开始分析' }));

    expect(onUpload).toHaveBeenCalledWith('C:\\plans\\curriculum.pdf');
  });

  it('uses the preload-resolved path for a dropped file', async () => {
    const file = new File(['content'], 'curriculum.pdf', { type: 'application/pdf' });
    vi.mocked(window.electronAPI.getPathForFile).mockReturnValue('D:\\imports\\curriculum.pdf');
    const onUpload = vi.fn();
    const { container } = render(<EmptyState {...baseProps} onUpload={onUpload} />);

    const dropzone = container.querySelector('.ap-empty__dropzone');
    expect(dropzone).not.toBeNull();
    fireEvent.drop(dropzone!, { dataTransfer: { files: [file] } });
    await waitFor(() => expect(screen.getByRole('button', { name: '开始分析' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '开始分析' }));

    expect(window.electronAPI.getPathForFile).toHaveBeenCalledWith(file);
    expect(onUpload).toHaveBeenCalledWith('D:\\imports\\curriculum.pdf');
  });

  it('does not submit an unresolved dropped file path', () => {
    const file = new File(['content'], 'curriculum.pdf', { type: 'application/pdf' });
    vi.mocked(window.electronAPI.getPathForFile).mockReturnValue('');
    const onUpload = vi.fn();
    const { container } = render(<EmptyState {...baseProps} onUpload={onUpload} />);

    fireEvent.drop(container.querySelector('.ap-empty__dropzone')!, { dataTransfer: { files: [file] } });

    expect(screen.getByRole('button', { name: '开始分析' })).toBeDisabled();
    expect(onUpload).not.toHaveBeenCalled();
  });
});
