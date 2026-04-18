/**
 * FloatingBubbleBridge — 真 Android 系统悬浮窗的 TS 封装
 *
 * 基于 WindowManager + TYPE_APPLICATION_OVERLAY，
 * closePluginView() 后仍存活，不受 PluginHost 冻结影响。
 *
 * 用法：
 *   import FloatingBubbleBridge from './FloatingBubbleBridge';
 *   FloatingBubbleBridge.show('无间距接收中');
 *   FloatingBubbleBridge.hide();
 *   const sub = FloatingBubbleBridge.onDragEnd(({pageY}) => setInsertTop(pageY));
 *   sub.remove();
 */

import { NativeModules, NativeEventEmitter, Platform } from 'react-native';

const { FloatingBubble } = NativeModules;

// 事件名
const EVENT_TAP = 'onBubbleTap';
const EVENT_DRAG_END = 'onBubbleDragEnd';

let _emitter: NativeEventEmitter | null = null;

function getEmitter(): NativeEventEmitter | null {
  if (!FloatingBubble) return null;
  if (!_emitter) {
    _emitter = new NativeEventEmitter(FloatingBubble);
  }
  return _emitter;
}

const FloatingBubbleBridge = {
  /** 模块是否可用（Native 侧已注册） */
  isAvailable: !!FloatingBubble,

  /**
   * 显示悬浮窗。如果已显示则更新文字。
   * @param statusText 状态文字，如 "无间距接收中"
   */
  show(statusText: string): void {
    try {
      FloatingBubble?.show(statusText);
    } catch (e) {
      console.warn('[FloatingBubbleBridge]: show failed:', e);
    }
  },

  /** 隐藏并移除悬浮窗 */
  hide(): void {
    try {
      FloatingBubble?.hide();
    } catch (e) {
      console.warn('[FloatingBubbleBridge]: hide failed:', e);
    }
  },

  /** 更新悬浮窗状态文字 */
  updateText(text: string): void {
    try {
      FloatingBubble?.updateText(text);
    } catch (e) {
      console.warn('[FloatingBubbleBridge]: updateText failed:', e);
    }
  },

  /** 设置页面高度（用于拖拽坐标映射） */
  setPageHeight(height: number): void {
    try {
      FloatingBubble?.setPageHeight(height);
    } catch (e) {}
  },

  /** 设置屏幕高度（用于拖拽坐标映射） */
  setScreenHeight(height: number): void {
    try {
      FloatingBubble?.setScreenHeight(height);
    } catch (e) {}
  },

  /**
   * 程序化移动气泡到指定页面 Y 坐标对应的屏幕位置。
   * 用于文本插入时让气泡实时跟随当前插入位置。
   */
  setPositionY(pageY: number): void {
    try {
      FloatingBubble?.setPositionY(pageY);
    } catch (e) {
      console.warn('[FloatingBubbleBridge]: setPositionY failed:', e);
    }
  },

  /** 检查悬浮窗是否正在显示 */
  async isShowing(): Promise<boolean> {
    try {
      return await FloatingBubble?.isShowing() ?? false;
    } catch {
      return false;
    }
  },

  /**
   * 检查是否有悬浮窗权限（SYSTEM_ALERT_WINDOW）。
   * Android 6.0+ 需要用户手动在设置中授权。
   */
  async checkPermission(): Promise<boolean> {
    try {
      return await FloatingBubble?.checkOverlayPermission() ?? false;
    } catch {
      return false;
    }
  },

  /**
   * 引导用户到系统设置开启悬浮窗权限。
   * 注意：PluginHost 的 packageName 是 com.ratta.supernote.pluginhost，
   * 需要对这个包开启"显示在其他应用上层"权限。
   */
  requestPermission(): void {
    try {
      FloatingBubble?.requestOverlayPermission();
    } catch (e) {
      console.warn('[FloatingBubbleBridge]: requestPermission failed:', e);
    }
  },

  /**
   * 设置 action 按钮列表（显示在状态文字下方的按钮行）。
   * @param buttons [{id, icon, label}, ...] — 空数组隐藏按钮行
   */
  setActionButtons(buttons: { id: string; icon: string; label: string }[]): void {
    try {
      FloatingBubble?.setActionButtons(JSON.stringify(buttons));
    } catch (e) {
      console.warn('[FloatingBubbleBridge]: setActionButtons failed:', e);
    }
  },

  /**
   * 监听气泡点击事件（用户点击气泡 → 打开主面板）
   */
  onTap(callback: () => void): { remove(): void } {
    const emitter = getEmitter();
    if (!emitter) return { remove() {} };
    const sub = emitter.addListener(EVENT_TAP, () => callback());
    return sub;
  },

  /** 监听气泡长按事件（长按 600ms → 切换到 toolbar 模式） */
  onLongPress(callback: () => void): { remove(): void } {
    const emitter = getEmitter();
    if (!emitter) return { remove() {} };
    const sub = emitter.addListener('onBubbleLongPress', () => callback());
    return sub;
  },

  /**
   * 监听气泡拖拽结束事件
   * @param callback 接收 { screenY: number, pageY: number }
   */
  onDragEnd(callback: (data: { screenY: number; pageY: number }) => void): { remove(): void } {
    const emitter = getEmitter();
    if (!emitter) return { remove() {} };
    const sub = emitter.addListener(EVENT_DRAG_END, (event) => {
      callback({ screenY: event.screenY, pageY: event.pageY });
    });
    return sub;
  },

  /**
   * 监听权限被拒事件（show() 时权限不足触发）。
   * 收到后应引导用户调用 requestPermission()，并降级到 RN 气泡。
   */
  onPermissionDenied(callback: () => void): { remove(): void } {
    const emitter = getEmitter();
    if (!emitter) return { remove() {} };
    const sub = emitter.addListener('onBubblePermissionDenied', () => callback());
    return sub;
  },

  /** 监听 action 按钮点击事件（状态行下方的功能按钮） */
  onBubbleAction(callback: (data: { actionId: string }) => void): { remove(): void } {
    const emitter = getEmitter();
    if (!emitter) return { remove() {} };
    return emitter.addListener('onBubbleAction', callback);
  },
};

export default FloatingBubbleBridge;
