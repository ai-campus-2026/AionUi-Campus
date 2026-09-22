/**
 * 学业路径页面的悬浮式 AI 助手（可拖拽版）。
 * - AI 核心 + 双环旋转外观
 * - 可拖拽到任意位置，聊天框智能定位（position: fixed）
 * - 聊天框 8 方向可拖拽调整大小
 * - 定时弹出提示语引导用户
 * - 点击展开聊天框，关闭不清除对话
 */
import { ipcBridge } from '@/common';
import type { ChatFileRef } from '@/common/types/chatFile';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Course, ProgramPlan, StudentProgress } from '../types';
import AcademicPathChat from './AcademicPathChat';
import { buildAcademicContext } from '../contextBuilder';

interface Props {
  selectedCourse: Course | null;
  plan: ProgramPlan;
  progress: StudentProgress;
  userInfo?: Record<string, string>;
}

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const QUICK_QUESTIONS_DEFAULT = [
  '我现在可以修哪些课程？',
  '帮我看看当前学业状态',
  '哪些课程还没有修？',
  '学分完成情况怎么样？',
];

// 定时提示语（随机轮换）
const HINT_MESSAGES = [
  '有学业问题？随时点我聊聊～',
  '想知道接下来该修什么课？我可以帮你分析',
  '课程先修关系看不懂？问我就对了',
  '需要帮你看看学分完成进度吗？',
  '你的学业路径有什么疑问吗？点击我试试',
  '我可以帮你规划接下来的学期安排哦',
  '不确定某门课能不能修？让我帮你看看',
];

const POPUP_MIN_W = 320;
const POPUP_MIN_H = 380;
const ROBOT_GAP = 14;

// 计算机器人在视口中的中心坐标
function getRobotCenter(posX: number, posY: number): { x: number; y: number } {
  if (typeof window === 'undefined') return { x: 800, y: 500 };
  // 初始位置：right:28, bottom:28，机器人核心约 38px，环约 64px
  const centerX = window.innerWidth - 28 - 32 + posX;
  const centerY = window.innerHeight - 28 - 45 + posY;
  return { x: centerX, y: centerY };
}

function getQuadrant(posX: number, posY: number): 'tl' | 'tr' | 'bl' | 'br' {
  const { x, y } = getRobotCenter(posX, posY);
  const isLeft = x < window.innerWidth / 2;
  const isTop = y < window.innerHeight / 2;
  if (isTop && isLeft) return 'tl';
  if (isTop && !isLeft) return 'tr';
  if (!isTop && isLeft) return 'bl';
  return 'br';
}

// 机器人在 wrapper 内的中心坐标（外环约64px，标签在下方）
const ROBOT_CENTER_IN_WRAPPER = { x: 32, y: 32 };

// 根据象限计算弹窗相对于 wrapper 的初始位置（position: absolute）
function calcPopupInitialPos(quadrant: string, width: number, height: number) {
  const cx = ROBOT_CENTER_IN_WRAPPER.x;
  const cy = ROBOT_CENTER_IN_WRAPPER.y;
  let left = 0;
  let top = 0;
  switch (quadrant) {
    case 'br': // 弹窗在机器人左上方
      left = cx - width - ROBOT_GAP;
      top = cy - height - ROBOT_GAP;
      break;
    case 'bl': // 弹窗在机器人右上方
      left = cx + ROBOT_GAP;
      top = cy - height - ROBOT_GAP;
      break;
    case 'tr': // 弹窗在机器人左下方
      left = cx - width - ROBOT_GAP;
      top = cy + ROBOT_GAP;
      break;
    case 'tl': // 弹窗在机器人右下方
    default:
      left = cx + ROBOT_GAP;
      top = cy + ROBOT_GAP;
      break;
  }
  return { left, top };
}

const FloatingAIAssistant: React.FC<Props> = ({ selectedCourse, plan, progress, userInfo: userInfoProp }) => {
  const [open, setOpen] = useState(false);
  // 读取"我的信息"数据（每次发送消息时重新读，保证最新）
  const readMyInfo = (): Record<string, string> => {
    try {
      const raw = localStorage.getItem('academic-path:my-info');
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return {};
  };
  const [convId, setConvId] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [hint, setHint] = useState<string | null>(null);
  const [popupSize, setPopupSize] = useState({ width: 360, height: 480 });
  const [popupOffset, setPopupOffset] = useState<{ left: number; top: number } | null>(null);
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, origX: 0, origY: 0, moved: false });
  const resizeRef = useRef<{
    active: ResizeDir | null;
    startX: number;
    startY: number;
    startLeft: number;
    startTop: number;
    startW: number;
    startH: number;
  }>({ active: null, startX: 0, startY: 0, startLeft: 0, startTop: 0, startW: 0, startH: 0 });
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const quadrant = getQuadrant(pos.x, pos.y);

  // 打开弹窗时重置自定义偏移，让位置根据当前象限自动计算
  useEffect(() => {
    if (open) setPopupOffset(null);
  }, [open]);

  // 拖拽 + resize 全局监听
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      // 机器人拖拽
      if (dragRef.current.dragging) {
        const dx = e.clientX - dragRef.current.startX;
        const dy = e.clientY - dragRef.current.startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragRef.current.moved = true;
        setPos({ x: dragRef.current.origX + dx, y: dragRef.current.origY + dy });
        return;
      }
      // 弹窗 resize
      const r = resizeRef.current;
      if (!r.active) return;
      const dx = e.clientX - r.startX;
      const dy = e.clientY - r.startY;
      const maxW = window.innerWidth * 0.85;
      const maxH = window.innerHeight * 0.8;
      let width = r.startW;
      let height = r.startH;
      let offsetLeft: number | undefined;
      let offsetTop: number | undefined;
      const dir = r.active;

      if (dir.includes('e')) width = Math.max(POPUP_MIN_W, Math.min(maxW, r.startW + dx));
      if (dir.includes('s')) height = Math.max(POPUP_MIN_H, Math.min(maxH, r.startH + dy));
      if (dir.includes('w')) {
        const newW = Math.max(POPUP_MIN_W, Math.min(maxW, r.startW - dx));
        offsetLeft = r.startLeft + (r.startW - newW);
        width = newW;
      }
      if (dir.includes('n')) {
        const newH = Math.max(POPUP_MIN_H, Math.min(maxH, r.startH - dy));
        offsetTop = r.startTop + (r.startH - newH);
        height = newH;
      }

      setPopupSize({ width, height });
      if (offsetLeft !== undefined || offsetTop !== undefined) {
        setPopupOffset({
          left: offsetLeft ?? r.startLeft,
          top: offsetTop ?? r.startTop,
        });
      }
    };

    const handleMouseUp = () => {
      dragRef.current.dragging = false;
      resizeRef.current.active = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // 定时提示语
  useEffect(() => {
    const showHint = () => {
      const msg = HINT_MESSAGES[Math.floor(Math.random() * HINT_MESSAGES.length)];
      setHint(msg);
      hintHideTimerRef.current = setTimeout(() => setHint(null), 5000);
    };
    hintTimerRef.current = setTimeout(showHint, 6000);
    const interval = setInterval(showHint, 16000);
    return () => {
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      if (hintHideTimerRef.current) clearTimeout(hintHideTimerRef.current);
      clearInterval(interval);
    };
  }, []);

  const handleFabMouseDown = useCallback((e: React.MouseEvent) => {
    dragRef.current = {
      dragging: true,
      startX: e.clientX,
      startY: e.clientY,
      origX: pos.x,
      origY: pos.y,
      moved: false,
    };
    setHint(null);
    e.preventDefault();
  }, [pos]);

  const handleResizeStart = useCallback((dir: ResizeDir) => (e: React.MouseEvent) => {
    const currentPos = popupOffset || calcPopupInitialPos(quadrant, popupSize.width, popupSize.height);
    resizeRef.current = {
      active: dir,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: currentPos.left,
      startTop: currentPos.top,
      startW: popupSize.width,
      startH: popupSize.height,
    };
    e.preventDefault();
    e.stopPropagation();
  }, [popupOffset, popupSize, quadrant]);

  const handleFabClick = useCallback(() => {
    if (dragRef.current.moved) {
      dragRef.current.moved = false;
      return;
    }
    setHint(null);
    setOpen((v) => !v);
  }, []);

  const quickQuestions = selectedCourse
    ? [
        `我可以修「${selectedCourse.name}」吗？`,
        `「${selectedCourse.name}」会影响哪些后续课程？`,
        `为什么需要先修这些课程？`,
        '帮我看看当前学业状态',
      ]
    : QUICK_QUESTIONS_DEFAULT;

  const handleSendQuick = useCallback(
    async (question: string) => {
      if (!convId) return;
      setThinking(true);
      try {
        let input = question;
        if (selectedCourse) {
          const prereqNames = selectedCourse.prerequisites
            .map((pid) => plan.courses.find((c) => c.id === pid)?.name)
            .filter(Boolean)
            .join('、');
          input = `我正在查看「${selectedCourse.name}」课程（${selectedCourse.credits}学分，${selectedCourse.categoryLabel}）。${prereqNames ? `先修课程：${prereqNames}。` : ''}当前修读状态：${progress.courseStatuses[selectedCourse.id] || '未修读'}。${question}`;
        }
        const context = buildAcademicContext(plan, progress, selectedCourse, userInfoProp || readMyInfo());
        await ipcBridge.conversation.sendMessage.invoke({
          conversation_id: convId,
          input: context + input,
          files: [] as ChatFileRef[],
        });
      } catch {
        /* ignore */
      } finally {
        setTimeout(() => setThinking(false), 1500);
      }
    },
    [convId, selectedCourse, plan, progress],
  );

  const handleConvIdReady = useCallback((id: string) => {
    setConvId(id);
  }, []);

  const hintClass = `ap-ai-hint ap-ai-hint--${quadrant}`;
  const popupPos = popupOffset || calcPopupInitialPos(quadrant, popupSize.width, popupSize.height);

  // 8 个 resize 手柄配置
  const resizeHandles: Array<{ dir: ResizeDir; className: string }> = [
    { dir: 'n', className: 'ap-ai-resize ap-ai-resize--n' },
    { dir: 's', className: 'ap-ai-resize ap-ai-resize--s' },
    { dir: 'e', className: 'ap-ai-resize ap-ai-resize--e' },
    { dir: 'w', className: 'ap-ai-resize ap-ai-resize--w' },
    { dir: 'ne', className: 'ap-ai-resize ap-ai-resize--ne' },
    { dir: 'nw', className: 'ap-ai-resize ap-ai-resize--nw' },
    { dir: 'se', className: 'ap-ai-resize ap-ai-resize--se' },
    { dir: 'sw', className: 'ap-ai-resize ap-ai-resize--sw' },
  ];

  return (
    <div
      className="ap-ai-fab-wrapper"
      style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
    >
      {/* 定时提示语 */}
      {hint && !open && (
        <div className={hintClass}>
          <span className="ap-ai-hint__text">{hint}</span>
          <span className="ap-ai-hint__arrow" />
        </div>
      )}

      {/* 展开的聊天框（position: absolute，相对于 wrapper） */}
      {open && (
        <div
          className="ap-ai-popup"
          style={{
            position: 'absolute',
            left: popupPos.left,
            top: popupPos.top,
            width: popupSize.width,
            height: popupSize.height,
          }}
        >
          {/* 8 方向 resize 手柄 */}
          {resizeHandles.map(({ dir, className }) => (
            <div key={dir} className={className} onMouseDown={handleResizeStart(dir)} />
          ))}

          <div className="ap-ai-popup__header">
            <div className="ap-ai-popup__header-info">
              <span className="ap-ai-popup__title">AI 学业助手</span>
              <span className="ap-ai-popup__subtitle">基于你的培养方案和当前学业状态</span>
            </div>
            <button
              type="button"
              className="ap-ai-popup__close"
              onClick={() => setOpen(false)}
              aria-label="关闭"
            >
              ✕
            </button>
          </div>

          {selectedCourse && (
            <div className="ap-ai-popup__context">
              <span className="ap-ai-popup__context-label">当前查看</span>
              <span className="ap-ai-popup__context-course">「{selectedCourse.name}」</span>
              <span className="ap-ai-popup__context-meta">
                {selectedCourse.credits}学分 · {selectedCourse.categoryLabel}
              </span>
            </div>
          )}

          <div className="ap-ai-popup__quick">
            {quickQuestions.map((q) => (
              <button
                key={q}
                type="button"
                className="ap-ai-popup__quick-btn"
                onClick={() => handleSendQuick(q)}
              >
                {q}
              </button>
            ))}
          </div>

          <div className="ap-ai-popup__body">
            <AcademicPathChat
              taskId="academic-path-main"
              taskName="学业路径助手"
              plan={plan}
              progress={progress}
              selectedCourse={selectedCourse}
              onConvIdReady={handleConvIdReady}
            />
          </div>
        </div>
      )}

      {/* 悬浮 AI 核心（可拖拽） */}
      <button
        type="button"
        className={`ap-ai-fab ${open ? 'ap-ai-fab--open' : ''} ${thinking ? 'ap-ai-fab--thinking' : ''}`}
        onMouseDown={handleFabMouseDown}
        onClick={handleFabClick}
        aria-label={open ? '关闭 AI 学业助手' : '打开 AI 学业助手'}
      >
        {/* 外层光晕 */}
        <span className="ap-ai-fab__halo" />
        <span className="ap-ai-fab__halo ap-ai-fab__halo--outer" />

        {/* 双旋转环 */}
        <span className="ap-ai-fab__ring ap-ai-fab__ring--outer">
          <span className="ap-ai-fab__ring-dot ap-ai-fab__ring-dot--1" />
          <span className="ap-ai-fab__ring-dot ap-ai-fab__ring-dot--2" />
        </span>
        <span className="ap-ai-fab__ring ap-ai-fab__ring--inner">
          <span className="ap-ai-fab__ring-dot ap-ai-fab__ring-dot--3" />
        </span>

        {/* AI 核心球体 */}
        <span className="ap-ai-fab__core">
          <span className="ap-ai-fab__core-inner" />
          <span className="ap-ai-fab__core-shine" />
        </span>

        {/* 常驻标签 */}
        <span className="ap-ai-fab__tag">学业问题，问我</span>
      </button>
    </div>
  );
};

export default FloatingAIAssistant;
