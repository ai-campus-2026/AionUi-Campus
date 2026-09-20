import React from 'react';
import { FileText, History, User, Home, Refresh, ArrowLeft, Code } from '@icon-park/react';
import type { ViewName } from '../model';

const TABS: { key: ViewName; label: string; icon: React.ComponentType<{ size?: number | string; theme?: string; fill?: string | string[] }> }[] = [
  { key: 'analysis', label: '政策解读', icon: FileText },
  { key: 'reports', label: '我的报告', icon: History },
  { key: 'profile', label: '我的信息', icon: User },
];

const TopNav: React.FC<{
  view: ViewName;
  onTab: (v: ViewName) => void;
  onHome: () => void;
  onReset: () => void;
  onDebug?: () => void;
}> = ({ view, onTab, onHome, onReset, onDebug }) => (
  <header className='ra-topnav'>
    <button type='button' className='ra-topnav__brand' onClick={onHome} aria-label='返回首页'>
      <ArrowLeft size={16} theme='outline' fill='currentColor' />
      <span>返回</span>
    </button>

    <nav className='ra-topnav__tabs' aria-label='模块导航'>
      {TABS.map((t) => {
        const Icon = t.icon;
        const active = t.key === 'analysis' ? view === 'analysis' || view === 'entry' : view === t.key;
        return (
          <button
            key={t.key}
            type='button'
            className={`ra-topnav__tab${active ? ' ra-topnav__tab--active' : ''}`}
            onClick={() => onTab(t.key)}
          >
            <Icon size={14} theme='outline' fill='currentColor' />
            {t.label}
          </button>
        );
      })}
    </nav>

    <div className='ra-topnav__side'>
      {onDebug && (
        <button type='button' className='ra-topnav__iconbtn' title='调试注入' aria-label='调试注入' onClick={onDebug}>
          <Code size={15} theme='outline' fill='currentColor' />
        </button>
      )}
      <button type='button' className='ra-topnav__iconbtn' title='重置演示数据' aria-label='重置演示数据' onClick={onReset}>
        <Refresh size={15} theme='outline' fill='currentColor' />
      </button>
      <button type='button' className='ra-topnav__iconbtn' title='返回首页' aria-label='返回首页' onClick={onHome}>
        <Home size={15} theme='outline' fill='currentColor' />
      </button>
    </div>
  </header>
);

export default TopNav;
