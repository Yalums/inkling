/**
 * NativePageCheckerBridge — NativePageCheckerModule 的 TypeScript 封装
 *
 * 用 Android Handler.postDelayed 替代 JS setInterval，
 * 使 TextInserter 在 closePluginView() 冻结 JS 定时器后仍能自动检测翻页。
 *
 * 使用方式：
 *   NativePageCheckerBridge.startPolling(500);
 *   const sub = NativePageCheckerBridge.onTick(() => doSomething());
 *   // ...
 *   sub.remove();
 *   NativePageCheckerBridge.stopPolling();
 *
 * 注意：模块内只维护一个 native 轮询实例。
 * 多处调用 startPolling 会以最后一次的间隔覆盖（native 侧幂等）。
 */

import { NativeModules, NativeEventEmitter, EmitterSubscription } from 'react-native';

const { NativePageChecker } = NativeModules;

const EVENT_TICK = 'onPageCheckTick';

let _emitter: NativeEventEmitter | null = null;

function getEmitter(): NativeEventEmitter | null {
  if (!NativePageChecker) return null;
  if (!_emitter) {
    _emitter = new NativeEventEmitter(NativePageChecker);
  }
  return _emitter;
}

const NativePageCheckerBridge = {
  /** 模块是否可用（native 侧已注册） */
  isAvailable: !!NativePageChecker,

  /**
   * 启动 Android Handler 轮询。幂等，重复调用以新间隔重启。
   * @param intervalMs 轮询间隔毫秒数（最小 100ms）
   */
  startPolling(intervalMs: number): void {
    try {
      NativePageChecker?.startPolling(intervalMs);
    } catch (e) {
      console.warn('[NativePageCheckerBridge]: startPolling failed:', e);
    }
  },

  /**
   * 停止轮询。幂等，可安全多次调用。
   * 通常在 TextInserter.stop() 时调用。
   */
  stopPolling(): void {
    try {
      NativePageChecker?.stopPolling();
    } catch (e) {
      console.warn('[NativePageCheckerBridge]: stopPolling failed:', e);
    }
  },

  /**
   * 订阅轮询 tick 事件。
   * @param callback  每次 tick 时调用
   * @returns         订阅句柄，调用 .remove() 取消订阅
   */
  onTick(callback: () => void): { remove(): void } {
    const emitter = getEmitter();
    if (!emitter) {
      console.warn('[NativePageCheckerBridge]: NativePageChecker not available, tick events disabled');
      return { remove() {} };
    }
    const sub: EmitterSubscription = emitter.addListener(EVENT_TICK, () => {
      try {
        callback();
      } catch (e) {
        console.warn('[NativePageCheckerBridge]: tick callback error:', e);
      }
    });
    return sub;
  },
};

export default NativePageCheckerBridge;
