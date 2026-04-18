/**
 * BackgroundService — 模块级后台服务
 *
 * 管理所有不依赖 UI 的后台能力：
 *   - TextInserter 单例（文本插入引擎）
 *   - Broadcast / LocalSend 文本接收监听
 *   - toggleMode: 工具栏 T= / T¶ 按钮的点击逻辑（开→关→切换）
 *   - handleAiSend: lasso_ai 工具的后台处理
 *   - 位置信息上报给中继 App
 *
 * 设计原则：
 *   - ensureInit() 幂等，可多次调用
 *   - 所有状态在模块作用域，不受 closePluginView() / 组件卸载影响
 *   - App.tsx 通过 DeviceEventEmitter('insertModeChanged') 同步 UI 状态
 *
 * 与 LocalSend 插件的区别：
 *   - 移除了按钮 201 的标签同步（没有 NativePluginManager.modifyButtonRes 调用）
 *   - 新增 toggleMode(target)：tap 同模式 → 停止；tap 其他模式 → 切换；关闭中 → 启动
 *   - FloatingBubbleBridge 仅用于 AI 等待状态气泡，不再同步普通模式状态
 *     （普通模式状态由 QuickToolbar 悬浮工具栏上的按钮高亮反映）
 */

import { NativeModules, NativeEventEmitter, DeviceEventEmitter } from 'react-native';
import { PluginCommAPI } from 'sn-plugin-lib';
import { TextInserter, InsertMode, TextSource } from './TextInserter';
import { FileLogger } from './FileLogger';
import LocalSendBridge, { TextReceivedInfo } from './LocalSendBridge';
import { LassoExtractor } from './LassoExtractor';
import FloatingBubbleBridge from './FloatingBubbleBridge';
import { loadBubbleActions, resolveBubbleActions } from './ToolPresets';
import { t } from './i18n';
import FloatingToolbarBridge from './FloatingToolbarBridge';

const { BroadcastBridge } = NativeModules;

// ── 常量 ──
const AI_REPLY_GAP_PX = 80;

// ── 模块级单例 ──
let _textInserter: TextInserter | null = null;
let _broadcastTextSub: { remove(): void } | null = null;
let _lsTextSub: { remove(): void } | null = null;
let _initialized = false;
let _activeMode: InsertMode | null = null;
let _lastMode: InsertMode = 'nospacing';
let _aiWaiting = false;
let _aiTimeoutRef: ReturnType<typeof setTimeout> | null = null;
let _nativeBubblePermission: boolean | null = null;
/** handleAiSend 最近一次成功触发的时间戳，防止快速重复点击或事件队列积压导致多次发送 */
let _lastAiSendAt = 0;
/** 气泡 action 按钮事件订阅 */
let _bubbleActionSub: { remove(): void } | null = null;
/** Native 面板关闭事件订阅（NativeSendPanel / NativeLassoScreenshotPanel 共用） */
let _nativePanelCloseSub: { remove(): void } | null = null;
/** 缓存的气泡 action 启用列表 */
let _cachedBubbleActionIds: string[] = [];

// ── Bridge 重建 ──

/**
 * 重建 BroadcastBridge 订阅。幂等，任何时候安全调用。
 *
 * 【为什么需要这个函数】
 * PluginHost 每次 closePluginView() 后会销毁并重建 CatalystInstance。
 * - BroadcastBridgeModule 是新实例，onCatalystInstanceDestroy() 已注销旧 receiver
 * - JS 侧 _initialized=true，ensureInit() 早 return，不会重新调用 startListening()
 * - _broadcastTextSub 是旧 NativeEventEmitter 的引用，指向已销毁的 Module 实例，
 *   后续 onTextFromRelay 事件永久不触发
 *
 * 【修复策略】
 * 移除旧订阅 → 对新 Module 实例调 startListening() → 用新实例重建 NativeEventEmitter
 * 在 ensureInit() / reviveIfNeeded() / handleAiSend() 三处调用，形成三道保险。
 */
function reviveBridge(): void {
  if (!BroadcastBridge) return;

  // 1. 移除旧 emitter 的订阅（旧实例已死，继续持有只会内存泄漏）
  if (_broadcastTextSub) {
    _broadcastTextSub.remove();
    _broadcastTextSub = null;
  }

  // 2. 对（可能是全新的）Module 实例重新注册 Android BroadcastReceiver
  BroadcastBridge.startListening();

  // 3. 用新 Module 实例重建 NativeEventEmitter 和 JS 事件订阅
  const bbEmitter = new NativeEventEmitter(BroadcastBridge);
  _broadcastTextSub = bbEmitter.addListener('onTextFromRelay', (text: string) => {
    console.log('[BackgroundService]: onTextFromRelay len=', text.length);
    FileLogger.logTextReceived('Broadcast', text);

    // 立即回传确认：告诉中转站本条已送达，防止其在 PLUGIN_ALIVE 时重复发送
    try { BroadcastBridge.sendAck(text, true, null); } catch (_) {}

    // 收到回复：清除 AI 等待超时
    if (_aiTimeoutRef !== null) {
      clearTimeout(_aiTimeoutRef);
      _aiTimeoutRef = null;
    }
    _textInserter?.enqueue(text, 'broadcast');
  });

  console.log('[BackgroundService]: bridge revived');
}

// ── 原生悬浮窗辅助 ──

export async function checkNativeBubblePermission(): Promise<boolean> {
  if (!FloatingBubbleBridge.isAvailable) return false;
  if (_nativeBubblePermission !== null) return _nativeBubblePermission;
  _nativeBubblePermission = await FloatingBubbleBridge.checkPermission();
  return _nativeBubblePermission;
}

export function invalidatePermissionCache(): void {
  _nativeBubblePermission = null;
}

export function requestNativeBubblePermission(): void {
  FloatingBubbleBridge.requestPermission();
}

/** 设置 AI 等待气泡（由 QuickToolbar 悬浮工具栏的按钮高亮反映普通模式状态，所以这里只管 AI 等待） */
function showAiBubble(on: boolean): void {
  if (!FloatingBubbleBridge.isAvailable) return;
  if (on) {
    const ps = _textInserter?.getPageSize();
    if (ps) FloatingBubbleBridge.setPageHeight(ps.height);
    FloatingBubbleBridge.show(t('bubble_ai_waiting'));
    syncBubbleActionsToNative();
  } else {
    FloatingBubbleBridge.hide();
  }
}

/**
 * 根据当前模式和 TextInserter 状态生成气泡状态文字。
 * - 正常插入中："无间距接收中" / "段落接收中"
 * - 等待翻页：  "无间距接收中 ⊕"
 * - 队列有待处理："无间距接收中 (3)"
 */
function _getBubbleStatusText(): string {
  if (!_activeMode) return '';
  const base = _activeMode === 'nospacing'
    ? t('bubble_recv_nospacing')
    : t('bubble_recv_paragraph');
  if (_textInserter?.isPageWaiting()) {
    return base + ' ⊕';
  }
  const qLen = _textInserter?.getQueueLength() ?? 0;
  if (qLen > 0) return base + ` (${qLen})`;
  return base;
}

/**
 * 同步气泡 action 按钮到 native 悬浮窗。
 * 在气泡显示时调用，读取已缓存的配置并传给 native。
 */
function syncBubbleActionsToNative(): void {
  if (!FloatingBubbleBridge.isAvailable) return;
  const actions = resolveBubbleActions(_cachedBubbleActionIds);
  FloatingBubbleBridge.setActionButtons(actions);
}

/** 刷新气泡 action 缓存（设置变更后调用） */
export async function refreshBubbleActions(): Promise<void> {
  _cachedBubbleActionIds = await loadBubbleActions();
  syncBubbleActionsToNative();
}

// ── 初始化 ──

export function ensureInit(): void {
  if (_initialized) return;
  _initialized = true;

  console.log('[BackgroundService]: ── initializing ──');

  _textInserter = new TextInserter(
    (text, success, error) => {
      if (BroadcastBridge) {
        BroadcastBridge.sendAck(text, success, error);
        try { BroadcastBridge.ackPendingText?.(text); } catch (_) {}
      }
      // AI 回复首次插入成功：更新气泡文字回到模式状态
      if (success && _aiWaiting) {
        _aiWaiting = false;
      }
      // 每次插入后刷新气泡状态文字（队列长度、page-wait 等状态可能已变）
      if (_activeMode && FloatingBubbleBridge.isAvailable) {
        FloatingBubbleBridge.updateText(_getBubbleStatusText());
      }
    },
    (page, nextTop, source, isPageChange) => {
      // 始终通知中转站 App 当前插入位置
      try {
        if (BroadcastBridge?.sendInsertPosition) {
          BroadcastBridge.sendInsertPosition(page, nextTop);
        }
      } catch (e) {
        console.warn('[BackgroundService]: sendInsertPosition failed:', e);
      }
      // 翻页时同步最新页面高度，保证 native 侧拖拽坐标映射正确
      if (isPageChange && FloatingBubbleBridge.isAvailable) {
        const ps = _textInserter?.getPageSize();
        if (ps) FloatingBubbleBridge.setPageHeight(ps.height);
      }
      // LocalSend 来源：每次插入后实时移动气泡跟随
      if (source === 'localsend' && FloatingBubbleBridge.isAvailable) {
        FloatingBubbleBridge.setPositionY(nextTop);
      }
      // Broadcast(中转站) 来源：仅翻页后移动一次气泡
      if (source === 'broadcast' && isPageChange && FloatingBubbleBridge.isAvailable) {
        FloatingBubbleBridge.setPositionY(nextTop);
      }
    },
    // ── 笔记上下文变更回调 ──
    (reason, detail) => {
      console.warn('[BackgroundService]: note context changed:', reason, detail);
      FileLogger.logEvent('NoteContextChanged', `${reason}: ${detail}`);
      _activeMode = null;
      _aiWaiting = false;
      if (_aiTimeoutRef !== null) { clearTimeout(_aiTimeoutRef); _aiTimeoutRef = null; }
      DeviceEventEmitter.emit('insertModeChanged', { mode: null });
      if (FloatingBubbleBridge.isAvailable) {
        const msg = reason === 'note_switched'
          ? t('note_switched_stop')
          : t('pages_changed_stop');
        FloatingBubbleBridge.show(msg);
        setTimeout(() => FloatingBubbleBridge.hide(), 3500);
      }
    },
    // ── page-wait 状态变更回调 ──
    // 进入/离开等待翻页时更新气泡状态文字（显示 ⊕ 标志）
    (_waiting, _targetPage) => {
      if (_activeMode && FloatingBubbleBridge.isAvailable) {
        FloatingBubbleBridge.updateText(_getBubbleStatusText());
      }
    },
  );

  // 建立 BroadcastBridge 订阅（首次初始化路径）
  reviveBridge();

  if (!_lsTextSub) {
    _lsTextSub = LocalSendBridge.onTextReceived((info: TextReceivedInfo) => {
      console.log('[BackgroundService]: onTextReceived(LocalSend) len=', info.text.length);
      FileLogger.logTextReceived('LocalSend', info.text);
      if (info._pendingId) LocalSendBridge.ackPendingText(info._pendingId);
      _textInserter?.enqueue(info.text, 'localsend');
    });
  }

  LocalSendBridge.startServer({
    alias: 'Supernote', port: 53317,
    dest: '/sdcard/INBOX', pin: '',
  }).catch(e => console.log('[BackgroundService]: startServer error:', e));

  try { BroadcastBridge?.sendAlive?.(); } catch (_) {}

  if (FloatingBubbleBridge.isAvailable) {
    FloatingBubbleBridge.onDragEnd(({ pageY }) => {
      _textInserter?.forceSetNextTop(pageY);
    });

    // ── 气泡 action 按钮事件 ──
    if (!_bubbleActionSub) {
      _bubbleActionSub = FloatingBubbleBridge.onBubbleAction(({ actionId }) => {
        console.log('[LASSO-DBG/JS] bubble action received:', actionId);
        if (actionId === 'lasso_ai') {
          handleAiSend().catch(e => console.error('[BackgroundService]: bubble lasso_ai error:', e));
        } else if (actionId === 'lasso_send') {
          // 原生面板路径：不再走 openPanel + React 透明占位，避免 plugin view 重建闪退
          FloatingBubbleBridge.hide();
          FloatingToolbarBridge.showNativeSendPanelFromBubble();
        } else if (actionId === 'screenshot_ai') {
          console.log('[LASSO-DBG/JS] dispatching screenshot_ai -> handleScreenshotAi');
          handleScreenshotAi().catch(e => console.error('[LASSO-DBG/JS] handleScreenshotAi threw:', e));
        } else {
          console.warn('[LASSO-DBG/JS] unknown actionId:', actionId);
        }
      });
    }

    // ── Native 面板关闭事件 —— 恢复气泡（仅当仍在 text receive 模式时） ──
    if (!_nativePanelCloseSub) {
      _nativePanelCloseSub = FloatingToolbarBridge.onNativePanelClose(({ panel, cameFromBubble }) => {
        console.log('[BackgroundService]: onNativePanelClose panel=', panel, 'fromBubble=', cameFromBubble);
        if (cameFromBubble) {
          // 延迟一点让 native 先完全清理 overlay，避免气泡被盖掉
          setTimeout(() => restoreBubbleAfterLasso(), 300);
        }
      });
    }
  }

  // ── 加载气泡 action 配置 ──
  loadBubbleActions().then(ids => { _cachedBubbleActionIds = ids; });

  FileLogger.logEvent('BackgroundInit', 'ready');
}

// ── 公开 API ──

export function getTextInserter(): TextInserter | null {
  return _textInserter;
}

export function getActiveMode(): InsertMode | null {
  return _activeMode;
}

export function isAiWaiting(): boolean {
  return _aiWaiting;
}

// ── Tool button 处理 ──

/**
 * 工具栏按钮触发的模式切换（tap-once UX）:
 *   - 当前未激活 → 启动 target
 *   - 当前 === target → 停止
 *   - 当前 !== target → 切换到 target（保留位置）
 * 发出 insertModeChanged 事件供 UI 同步高亮。
 */
export async function toggleMode(target: InsertMode): Promise<InsertMode | null> {
  ensureInit();
  if (!_textInserter) return null;

  const cur = _activeMode;
  if (cur === null) {
    await switchToMode(target);
  } else if (cur === target) {
    stopMode();
  } else {
    await switchToMode(target);
  }

  FileLogger.logEvent('ToggleMode', `target=${target} result=${_activeMode}`);
  return _activeMode;
}

export async function startMode(mode: InsertMode): Promise<boolean> {
  _lastMode = mode;
  return switchToMode(mode);
}

export function stopMode(): void {
  if (_textInserter) {
    const cur = _textInserter.getMode();
    if (cur) _lastMode = cur;
    _textInserter.stop(true);
  }
  _activeMode = null;
  // 停止时隐藏文本接收气泡（非 AI 等待态也会显示气泡了）
  if (!_aiWaiting && FloatingBubbleBridge.isAvailable) {
    FloatingBubbleBridge.hide();
  }
  DeviceEventEmitter.emit('insertModeChanged', { mode: null });
}

export async function switchToMode(mode: InsertMode): Promise<boolean> {
  ensureInit();
  if (!_textInserter) return false;

  const previousMode = _lastMode;
  _lastMode = mode;

  // 如果正在暂停中，恢复消费
  if (_textInserter.isPaused()) {
    _textInserter.resume();
  }

  if (_textInserter.isRunning()) {
    const ok = _textInserter.switchMode(mode);
    if (ok) {
      _activeMode = mode;
      DeviceEventEmitter.emit('insertModeChanged', { mode });
      return true;
    }
  }

  _textInserter.clearQueue();
  const ok = await _textInserter.start(mode, true);
  if (ok) {
    _textInserter.applyModeSwitchGap(previousMode, mode);
    _activeMode = mode;
    // 同步页面高度，保证 native 气泡拖拽坐标映射正确
    if (FloatingBubbleBridge.isAvailable) {
      const ps = _textInserter.getPageSize();
      if (ps) FloatingBubbleBridge.setPageHeight(ps.height);
    }
  } else {
    // start() 失败通常是 SDK 调用（getPageSize 等）在 plugin view 刚打开时尚未就绪
    // 最多重试 2 次，间隔递增，覆盖 CatalystInstance 重建慢的情况
    let retryOk = false;
    const retryDelays = [800, 2000];
    for (const delay of retryDelays) {
      await new Promise<void>(r => setTimeout(r, delay));
      // 如果在等待期间外部已经启动了（例如 reviveIfNeeded），跳过
      if (_textInserter.isRunning()) { retryOk = true; break; }
      console.log('[BackgroundService]: retrying start, delay=', delay);
      FileLogger.logEvent('StartRetry', `mode=${mode} delay=${delay}`);
      retryOk = await _textInserter.start(mode, true);
      if (retryOk) break;
    }
    if (retryOk) {
      _textInserter.applyModeSwitchGap(previousMode, mode);
      _activeMode = mode;
      if (FloatingBubbleBridge.isAvailable) {
        const ps = _textInserter.getPageSize();
        if (ps) FloatingBubbleBridge.setPageHeight(ps.height);
      }
    } else {
      _activeMode = null;
    }
  }
  DeviceEventEmitter.emit('insertModeChanged', { mode: _activeMode });

  // ── 模式激活时显示文本接收气泡（含 action 按钮） ──
  if (_activeMode && FloatingBubbleBridge.isAvailable) {
    FloatingBubbleBridge.show(_getBubbleStatusText());
    syncBubbleActionsToNative();
  }

  return ok;
}

/** 工具 lasso_ai: 套索 → 启动 nospacing → 定位 → sendQuery → 显示等待气泡 */
export async function handleAiSend(): Promise<void> {
  ensureInit();
  // ── 防抖：_aiWaiting 期间或 3s 内重复触发直接丢弃 ──
  // 原因：lasso_ai 通过 onToolTap 发送，plugin view 关闭时事件会在队列中积压，
  // 下次打开时一次性全部触发，导致发送多条相同 query。
  if (_aiWaiting) {
    console.log('[BackgroundService]: handleAiSend skipped (already waiting for AI reply)');
    FileLogger.logEvent('AiSendDebounce', 'aiWaiting');
    return;
  }
  const now = Date.now();
  if (now - _lastAiSendAt < 3000) {
    console.log('[BackgroundService]: handleAiSend debounced (< 3s since last send)');
    FileLogger.logEvent('AiSendDebounce', `gap=${now - _lastAiSendAt}ms`);
    return;
  }
  _lastAiSendAt = now;
  // 发送前确保广播 bridge 处于活跃状态（防止 closePluginView 重建周期后订阅失效）
  reviveBridge();
  console.log('[BackgroundService]: ── handleAiSend ──');

  try {
    const extracted = await LassoExtractor.extract();
    if (!extracted.text) {
      FileLogger.logEvent('AiSendAbort', 'no text');
      // 套索为空（plugin view 重开后选区被 note app 清除，或用户未套索）：
      // 给出可见反馈，避免静默失败让用户无从判断原因
      if (FloatingBubbleBridge.isAvailable) {
        FloatingBubbleBridge.show(t('bubble_ai_no_lasso'));
        setTimeout(() => {
          FloatingBubbleBridge.hide();
        }, 2500);
      }
      return;
    }
    if (!BroadcastBridge) {
      console.error('[BackgroundService]: BroadcastBridge not available');
      return;
    }

    // 取消套索选区：套索激活状态会限制 insertText 写入文本框。
    // 内容已提取完毕，此时取消选区不影响数据，但能解除 note app 的套索锁定。
    try {
      await Promise.race([
        (PluginCommAPI.setLassoBoxState as any)(2),
        new Promise((_, reject) => setTimeout(() => reject(new Error('setLassoBoxState timeout')), 3000)),
      ]);
      console.log('[BackgroundService]: lasso selection cleared');
    } catch (e) {
      console.warn('[BackgroundService]: setLassoBoxState failed (non-fatal):', e);
    }

    if (_textInserter) {
      // paused：用户点击气泡切回工具栏后的状态，直接恢复消费即可。
      // 不发 insertModeChanged —— AI 模式下工具栏应保持可见，气泡作为附加状态指示。
      if (_textInserter.isPaused()) {
        _textInserter.resume();
      } else if (!_textInserter.isRunning()) {
        // 首次启动：静默启动 nospacing，不隐藏工具栏
        _textInserter.clearQueue();
        const ok = await _textInserter.start('nospacing');
        if (ok) {
          _activeMode = 'nospacing';
          // 不发 insertModeChanged：工具栏继续可见，气泡作为等待状态的额外指示
        }
      }
    }

    if (extracted.lastTextBoxRect && _textInserter) {
      const startTop = extracted.lastTextBoxRect.bottom + AI_REPLY_GAP_PX;
      _textInserter.setStartTopIfAdvance(startTop);
    }

    // 发送前 sendAlive：唤醒中转站 app，防止空闲后丢失连接
    try { BroadcastBridge.sendAlive?.(); } catch (_) {}
    BroadcastBridge.sendQuery(extracted.text);
    _aiWaiting = true;
    showAiBubble(true);
    FileLogger.logEvent('SendToAI', `${extracted.text.length} chars`);

    // 90 秒无回复：更新气泡为超时提示，让用户明确知道中转站/AI 侧断联
    if (_aiTimeoutRef !== null) clearTimeout(_aiTimeoutRef);
    _aiTimeoutRef = setTimeout(() => {
      _aiTimeoutRef = null;
      if (_aiWaiting && FloatingBubbleBridge.isAvailable) {
        console.warn('[BackgroundService]: AI reply timeout');
        FileLogger.logEvent('AiTimeout', 'no reply in 90s');
        FloatingBubbleBridge.updateText('AI 无响应，请检查中转站');
        setTimeout(() => { if (!_aiWaiting) return; FloatingBubbleBridge.hide(); _aiWaiting = false; }, 5000);
      }
    }, 90_000);

  } catch (e) {
    console.error('[BackgroundService]: handleAiSend error:', e);
    FileLogger.logEvent('AiSendError', String(e));
  }
}

/** 工具 lasso_send 触发前提取 lasso 内容，返回给 App.tsx 打开发送屏幕。 */
export async function extractLassoForSend() {
  ensureInit();
  return LassoExtractor.extract();
}

export async function restartServer(dest: string): Promise<void> {
  try { await LocalSendBridge.stopServer(); } catch (_) {}
  try {
    await LocalSendBridge.startServer({ alias: 'Supernote', port: 53317, dest, pin: '' });
  } catch (e) {
    console.log('[BackgroundService]: restartServer error:', e);
  }
}

/**
 * 暂停文本消费（队列继续接收，但不往笔记写入）。
 * 用于：从文本状态气泡切回工具栏悬浮窗时。
 */
export function pauseInsertion(): void {
  _textInserter?.pause();
}

/**
 * 恢复文本消费。
 * 用于：从工具栏点击 T= / T¶ 恢复文本接收时。
 */
export function resumeInsertion(): void {
  _textInserter?.resume();
}

/** 是否处于暂停状态 */
export function isInsertionPaused(): boolean {
  return _textInserter?.isPaused() ?? false;
}

export function setInsertTop(pageTop: number): void {
  _textInserter?.forceSetNextTop(pageTop);
}

export function getInsertPosition(): { page: number; top: number } | null {
  if (!_textInserter) return null;
  return { page: _textInserter.getTargetPage(), top: _textInserter.getNextTop() };
}

export function getPageSize(): { width: number; height: number } | null {
  return _textInserter?.getPageSize() ?? null;
}

export async function flushPendingTexts(): Promise<number> {
  if (!BroadcastBridge?.flushPendingTexts || !_textInserter) return 0;
  try {
    const texts: string[] = await BroadcastBridge.flushPendingTexts();
    if (texts && texts.length > 0) {
      for (const tx of texts) _textInserter.enqueue(tx, 'broadcast');
      FileLogger.logEvent('FlushPending', `count=${texts.length}`);
    }
    return texts?.length ?? 0;
  } catch (e) {
    console.warn('[BackgroundService]: flushPendingTexts error:', e);
    return 0;
  }
}

export async function reviveIfNeeded(): Promise<void> {
  // 每次 plugin view 重新打开时重建 bridge 订阅，防止 CatalystInstance 重建后订阅失效
  reviveBridge();
  if (!_textInserter || !_activeMode) return;
  if (!_textInserter.hasLiveTimers()) {
    const mode = _activeMode;
    _textInserter.clearQueue();
    const ok = await _textInserter.start(mode, true);
    if (!ok) _activeMode = null;
    DeviceEventEmitter.emit('insertModeChanged', { mode: _activeMode });
  }
}

/**
 * 气泡 St 按钮：截屏 → 自由手绘 lasso → 发给 AI
 *
 * 走纯 native 路径（NativeLassoScreenshotPanel）：
 *   - screencap 在 native 面板内部完成
 *   - 手绘 lasso 通过 Canvas + PorterDuff 渲染，不经过 React
 *   - Confirm 后 native 直接写 mask JSON + 发广播给中转站
 *   - 面板关闭时 native emit onNativePanelClose，JS 恢复气泡
 *
 * 完全不再调用 showPluginView / openPanel / takeScreenshot —— 避开
 * Supernote 固件上 plugin view 重建的已知脆弱路径。
 */
export async function handleScreenshotAi(): Promise<void> {
  console.log('[LASSO-DBG] handleScreenshotAi START (native path)');
  FloatingBubbleBridge.hide();
  FloatingToolbarBridge.showNativeLassoScreenshotPanelFromBubble();
  FileLogger.logEvent('ScreenshotAi', 'native panel invoked');
}

/** 恢复气泡（供 lasso overlay 关闭时调用） */
export function restoreBubbleAfterLasso(): void {
  if (_activeMode && FloatingBubbleBridge.isAvailable) {
    FloatingBubbleBridge.show(_getBubbleStatusText());
  }
}
