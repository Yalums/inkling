/**
 * FloatingToolbarBridge — 系统级悬浮工具栏的 TS 封装
 *
 * 基于 WindowManager + TYPE_APPLICATION_OVERLAY，
 * closePluginView() 后仍存活，不受 PluginHost 冻结影响。
 *
 * 两种状态：
 *   - 展开 (expanded): 完整的工具网格 (2×2 / 3×2 / 4×2)
 *   - 收纳 (collapsed): 贴边的 6px 斑马纹指示条
 *
 * 用法:
 *   import FloatingToolbarBridge from './FloatingToolbarBridge';
 *   FloatingToolbarBridge.show(tools);      // 展开状态显示
 *   FloatingToolbarBridge.collapse();       // 收纳到边缘
 *   FloatingToolbarBridge.expand();         // 从边缘展开
 *   FloatingToolbarBridge.hide();           // 完全移除
 *   const sub = FloatingToolbarBridge.onToolTap(({toolId, toolAction}) => { ... });
 *   sub.remove();
 */

import { NativeModules, NativeEventEmitter } from 'react-native';

const { FloatingToolbar } = NativeModules;

export interface ToolItem {
  id: string;
  name: string;
  icon: string;   // emoji 或单字符
  action: string;  // 动作标识符
}

export interface ToolTapEvent {
  toolId: string;
  toolAction: string;
  toolName: string;
}

let _emitter: NativeEventEmitter | null = null;

function getEmitter(): NativeEventEmitter | null {
  if (!FloatingToolbar) return null;
  if (!_emitter) {
    _emitter = new NativeEventEmitter(FloatingToolbar);
  }
  return _emitter;
}

const FloatingToolbarBridge = {
  /** 模块是否可用（Native 侧已注册） */
  isAvailable: !!FloatingToolbar,

  /**
   * 显示悬浮工具栏（展开状态）。如果已显示则更新工具列表。
   * @param tools 工具列表
   */
  show(tools: ToolItem[]): void {
    try {
      FloatingToolbar?.show(JSON.stringify(tools));
    } catch (e) {
      console.warn('[FloatingToolbarBridge]: show failed:', e);
    }
  },

  /** 隐藏并移除悬浮工具栏（完全消失） */
  hide(): void {
    try {
      FloatingToolbar?.hide();
    } catch (e) {
      console.warn('[FloatingToolbarBridge]: hide failed:', e);
    }
  },

  /** 更新工具按钮列表 */
  updateTools(tools: ToolItem[]): void {
    try {
      FloatingToolbar?.updateTools(JSON.stringify(tools));
    } catch (e) {
      console.warn('[FloatingToolbarBridge]: updateTools failed:', e);
    }
  },

  /** 收纳到屏幕边缘（变为斑马纹指示条） */
  collapse(): void {
    try {
      FloatingToolbar?.collapse();
    } catch (e) {
      console.warn('[FloatingToolbarBridge]: collapse failed:', e);
    }
  },

  /** 从边缘展开（恢复完整工具栏） */
  expand(): void {
    try {
      FloatingToolbar?.expand();
    } catch (e) {
      console.warn('[FloatingToolbarBridge]: expand failed:', e);
    }
  },

  /** 设置停靠方向 ('left' | 'right') */
  setSide(side: 'left' | 'right'): void {
    try {
      FloatingToolbar?.setSide(side);
    } catch (e) {
      console.warn('[FloatingToolbarBridge]: setSide failed:', e);
    }
  },

  /** 检查悬浮窗是否正在显示 (异步版) */
  async isShowing(): Promise<boolean> {
    try {
      return await FloatingToolbar?.isShowing() ?? false;
    } catch { return false; }
  },

  /**
   * 同步检查悬浮窗是否正在显示。
   * 使用 native @ReactMethod(isBlockingSynchronousMethod=true)，
   * 无需 await，直接返回 boolean。适用于需要避免异步竞态的场景。
   */
  isShowingSync(): boolean {
    try {
      return FloatingToolbar?.isShowingSync() ?? false;
    } catch { return false; }
  },

  /**
   * Returns true (once) if the toolbar's ☰ button was the reason the plugin view opened.
   * Call on App.tsx mount. Resets to false after reading.
   */
  async checkPendingOpenMain(): Promise<boolean> {
    try {
      return await FloatingToolbar?.checkPendingOpenMain() ?? false;
    } catch { return false; }
  },

  /**
   * 同步版 checkPendingOpenMain — 在主线程阻塞返回 boolean，无需 await。
   * 不清除 pending flag —— 只有收到 JS 端的 ackOpenMain() 后 native 才会清除，
   * 保证即使第一次 emit 落在 onHostPause 期间也能通过重试送达。
   */
  checkPendingOpenMainSync(): boolean {
    try {
      return FloatingToolbar?.checkPendingOpenMainSync() ?? false;
    } catch { return false; }
  },

  /** 通知 native：onToolbarOpenMain 已被 JS 处理，可停止重试。 */
  ackOpenMain(): void {
    try { FloatingToolbar?.ackOpenMain(); } catch (_) {}
  },

  /** 工具点击路由：设置下一次打开 plugin view 时 App.tsx 应切到的屏幕名。 */
  setPendingScreen(name: string): void {
    try { FloatingToolbar?.setPendingScreen(name); } catch (_) {}
  },

  /** 同步读 pending screen；"" 表示无。不清除。 */
  getPendingScreenSync(): string {
    try { return FloatingToolbar?.getPendingScreenSync() ?? ''; } catch { return ''; }
  },

  /** 消费 pending screen 后清除。 */
  ackPendingScreen(): void {
    try { FloatingToolbar?.ackPendingScreen(); } catch (_) {}
  },

  /** 插入图片成功后删除 queue 文件（Kotlin 之前在 emit 前就删，导致 insertImage 读不到文件）。 */
  async deleteQueueFile(path: string): Promise<boolean> {
    try { return await FloatingToolbar?.deleteQueueFile(path) ?? false; } catch { return false; }
  },

  /** 请求 native 打开 plugin view（走 NativePluginManager.showPluginView 反射）。 */
  openPluginView(): void {
    try { FloatingToolbar?.openPluginView(); } catch (_) {}
  },

  /** 强制关闭 plugin view（绕过 PluginApp state 检查，直接调底层 NativePluginManager）。 */
  forceClosePluginView(): void {
    try { FloatingToolbar?.forceClosePluginView(); } catch (_) {}
  },

  /**
   * 显示全屏截图遮罩 + 中心 "截图中…" 提示。
   *
   * 用途：handleScreenshotAi 里 forceClosePluginView → screencap → openPluginView
   * 全程约 2.2s 无 UI 反馈，用户会以为点击无效而误操作（滑动切到文档页）。
   * 这个遮罩同时解决 Bug 2（视觉反馈）和 Bug 4（误触阻挡）。
   *
   * 独立于 rootView 的 WindowManager 视图，plugin view 关闭后仍然存活。
   * 重复调用幂等，已显示时忽略。
   */
  showCaptureToast(message?: string): void {
    try { FloatingToolbar?.showCaptureToast(message ?? ''); } catch (_) {}
  },

  /** 隐藏截图遮罩。幂等，未显示时无操作。 */
  hideCaptureToast(): void {
    try { FloatingToolbar?.hideCaptureToast(); } catch (_) {}
  },

  /**
   * 设置 pendingScreen + 复用 ☰ 的可靠打开序列（150ms 延迟 + 多次重试 emit）。
   * 收到 onToolbarOpenMain 时 JS 读 pendingScreen 决定路由目标。
   */
  openPanel(screen: string): void {
    try { FloatingToolbar?.openPanel(screen); } catch (_) {}
  },

  /** 检查悬浮窗权限 */
  async checkPermission(): Promise<boolean> {
    try {
      return await FloatingToolbar?.checkOverlayPermission() ?? false;
    } catch { return false; }
  },

  /**
   * 获取插件私有 sticker 存储目录路径。
   * 路径: /sdcard/Android/data/<packageName>/files/stickers/
   */
  async getStickerDir(): Promise<string | null> {
    try {
      return await FloatingToolbar?.getStickerDir() ?? null;
    } catch { return null; }
  },

  /**
   * 确保 sticker 目录存在并返回路径。
   * 在 saveStickerByLasso 前调用，防止目录被删后写入失败。
   */
  async ensureStickerDir(): Promise<string | null> {
    try {
      return await FloatingToolbar?.ensureStickerDir() ?? null;
    } catch { return null; }
  },

  /** 引导用户到系统设置开启权限 */
  requestPermission(): void {
    try {
      FloatingToolbar?.requestOverlayPermission();
    } catch (e) {
      console.warn('[FloatingToolbarBridge]: requestPermission failed:', e);
    }
  },

  /**
   * Pass extracted lasso data from JS to native NativeSendPanel.
   * Called after LassoExtractor.extract() completes.
   */
  setLassoData(text: string, imagePathsJson: string): void {
    try {
      FloatingToolbar?.setLassoData(text, imagePathsJson);
    } catch (e) {
      console.warn('[FloatingToolbarBridge]: setLassoData failed:', e);
    }
  },

  /** Show the native image panel (called when bubble is tapped) */
  showNativeImagePanel(): void {
    try {
      FloatingToolbar?.showNativeImagePanel();
    } catch (e) {
      console.warn('[FloatingToolbarBridge]: showNativeImagePanel failed:', e);
    }
  },

  /**
   * 从气泡触发 lasso_send。native 侧会：显示 NativeSendPanel → 轻触 plugin view
   * 跑 LassoExtractor → 数据回灌到面板。面板关闭时 emit onNativePanelClose。
   */
  showNativeSendPanelFromBubble(): void {
    try {
      FloatingToolbar?.showNativeSendPanelFromBubble();
    } catch (e) {
      console.warn('[FloatingToolbarBridge]: showNativeSendPanelFromBubble failed:', e);
    }
  },

  /**
   * 从气泡触发 screenshot_ai。native 侧会：screencap → 显示全屏 lasso 面板 →
   * Confirm 后写 mask JSON + 广播给中转站。关闭时 emit onNativePanelClose。
   * 完全不涉及 plugin view / RN 重建。
   */
  showNativeLassoScreenshotPanelFromBubble(): void {
    try {
      FloatingToolbar?.showNativeLassoScreenshotPanelFromBubble();
    } catch (e) {
      console.warn('[FloatingToolbarBridge]: showNativeLassoScreenshotPanelFromBubble failed:', e);
    }
  },

  // ── 事件监听 ──

  /** 工具按钮点击 */
  onToolTap(callback: (event: ToolTapEvent) => void): { remove(): void } {
    const emitter = getEmitter();
    if (!emitter) return { remove() {} };
    return emitter.addListener('onToolTap', callback);
  },

  /** 工具按钮长按 */
  onToolLongPress(callback: (event: { toolId: string; toolName: string }) => void): { remove(): void } {
    const emitter = getEmitter();
    if (!emitter) return { remove() {} };
    return emitter.addListener('onToolLongPress', callback);
  },

  /** 工具栏拖拽结束 */
  onDragEnd(callback: (pos: { x: number; y: number }) => void): { remove(): void } {
    const emitter = getEmitter();
    if (!emitter) return { remove() {} };
    return emitter.addListener('onToolbarDragEnd', callback);
  },

  /** 长按工具栏区域 (非按钮) -> 打开主面板 */
  onToolbarOpenMain(callback: () => void): { remove(): void } {
    const emitter = getEmitter();
    if (!emitter) return { remove() {} };
    return emitter.addListener('onToolbarOpenMain', () => callback());
  },

  /** 短按工具栏区域 (非按钮) */
  onTap(callback: () => void): { remove(): void } {
    const emitter = getEmitter();
    if (!emitter) return { remove() {} };
    return emitter.addListener('onToolbarTap', () => callback());
  },

  /** 权限被拒 */
  onPermissionDenied(callback: () => void): { remove(): void } {
    const emitter = getEmitter();
    if (!emitter) return { remove() {} };
    return emitter.addListener('onToolbarPermissionDenied', () => callback());
  },

  /** 工具栏收纳/展开状态变化 */
  onCollapseChange(callback: (data: { collapsed: boolean; side: string }) => void): { remove(): void } {
    const emitter = getEmitter();
    if (!emitter) return { remove() {} };
    return emitter.addListener('onToolbarCollapseChange', callback);
  },

  /**
   * Native 面板（NativeSendPanel / NativeLassoScreenshotPanel）关闭事件。
   * cameFromBubble=true 时 JS 侧应恢复文本气泡；否则 native 已处理工具栏恢复。
   */
  onNativePanelClose(
    callback: (data: { panel: string; cameFromBubble: boolean }) => void
  ): { remove(): void } {
    const emitter = getEmitter();
    if (!emitter) return { remove() {} };
    return emitter.addListener('onNativePanelClose', callback);
  },
};

export default FloatingToolbarBridge;
