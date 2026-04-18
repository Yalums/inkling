package com.supernote_quicktoolbar

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * NativePageCheckerModule — 基于 Android Handler 的定时轮询模块
 *
 * 替代 JS 层的 setInterval(() => _checkPageAndResume(), 500)。
 *
 * 【为什么需要它】
 * closePluginView() 调用后，PluginHost 会冻结 JS 引擎的 setTimeout/setInterval
 * 消息队列，导致跨页等待时 _checkPageAndResume 永远不再执行。
 * Android 的 Handler.postDelayed 运行在主线程 Looper，完全独立于 JS 定时器，
 * closePluginView() 后仍持续运行，通过 DeviceEventEmitter 把 tick 推给 JS 处理。
 *
 * 【性能对比 setInterval】
 * - 更轻量：Handler 是 Android Looper 原生机制，无 JS bridge 往返开销
 * - 更可靠：不受 JS 引擎调度策略影响
 * - 相同频率下触发精度更好（Handler 精度约 ±1ms，JS timer 受线程竞争影响）
 *
 * JS 侧调用：
 *   NativePageChecker.startPolling(intervalMs)  — 启动轮询
 *   NativePageChecker.stopPolling()             — 停止轮询
 *
 * JS 侧监听：
 *   DeviceEventEmitter.addListener('onPageCheckTick', callback)
 */
class NativePageCheckerModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "NativePageChecker"

    private val TAG = "NativePageChecker"
    private val handler = Handler(Looper.getMainLooper())
    private var intervalMs = 500L
    private var running = false
    private var tickCount = 0L

    private val tickRunnable = object : Runnable {
        override fun run() {
            if (!running) return
            tickCount++
            try {
                reactApplicationContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("onPageCheckTick", tickCount.toDouble())
            } catch (e: Exception) {
                // JS bridge 可能在 Catalyst 销毁期间不可用，静默忽略
                Log.w(TAG, "emit onPageCheckTick failed: ${e.message}")
            }
            handler.postDelayed(this, intervalMs)
        }
    }

    /**
     * 启动定时轮询。幂等：重复调用会以新间隔重启。
     * @param ms 轮询间隔，单位毫秒（建议 500）
     */
    @ReactMethod
    fun startPolling(ms: Int) {
        handler.removeCallbacks(tickRunnable)
        intervalMs = ms.toLong().coerceAtLeast(100L) // 最低 100ms，防止滥用
        running = true
        tickCount = 0L
        handler.postDelayed(tickRunnable, intervalMs)
        Log.i(TAG, "startPolling intervalMs=$intervalMs")
    }

    /**
     * 停止定时轮询。幂等，可安全多次调用。
     */
    @ReactMethod
    fun stopPolling() {
        running = false
        handler.removeCallbacks(tickRunnable)
        Log.i(TAG, "stopPolling (totalTicks=$tickCount)")
    }

    // ── RN 事件发射器必须的 boilerplate ──────────────────────────────────────

    @ReactMethod
    fun addListener(eventName: String) {
        // RN 事件订阅计数，框架调用
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // RN 事件取消订阅计数，框架调用
    }

    // ── 生命周期 ──────────────────────────────────────────────────────────────

    override fun onCatalystInstanceDestroy() {
        stopPolling()
        super.onCatalystInstanceDestroy()
    }
}
