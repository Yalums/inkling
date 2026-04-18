package com.supernote_quicktoolbar

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule

class BroadcastBridgeModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "BroadcastBridge"

    private var receiver: BroadcastReceiver? = null

    @ReactMethod
    fun startListening() {
        if (receiver != null) return

        receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action == "com.dictation.TEXT_TO_PLUGIN") {
                    val text = intent.getStringExtra("text") ?: return
                    reactApplicationContext
                        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                        .emit("onTextFromRelay", text)
                }
            }
        }

        reactApplicationContext.registerReceiver(
            receiver,
            IntentFilter("com.dictation.TEXT_TO_PLUGIN"),
            Context.RECEIVER_EXPORTED
        )
    }

    @ReactMethod
    fun sendAck(text: String, success: Boolean, error: String?) {
        val intent = Intent("com.dictation.ACK_FROM_PLUGIN").apply {
            putExtra("text", text)
            putExtra("success", success)
            error?.let { putExtra("error", it) }
        }
        reactApplicationContext.sendBroadcast(intent)
    }

    @ReactMethod
    fun sendQuery(text: String) {
        val intent = Intent("com.dictation.QUERY_FROM_PLUGIN").apply {
            putExtra("text", text)
        }
        reactApplicationContext.sendBroadcast(intent)
    }

    @ReactMethod
    fun sendAlive() {
        val intent = Intent("com.dictation.PLUGIN_ALIVE")
        reactApplicationContext.sendBroadcast(intent)
        Log.i("BroadcastBridge", "PLUGIN_ALIVE sent")
    }

    @ReactMethod
    fun sendImageQuery(imagePath: String, maskPath: String, prompt: String) {
        val intent = Intent("com.dictation.IMAGE_QUERY_FROM_PLUGIN").apply {
            putExtra("imagePath", imagePath)
            putExtra("maskPath", maskPath)
            putExtra("prompt", prompt)
        }
        reactApplicationContext.sendBroadcast(intent)
    }

    @ReactMethod
    fun sendInsertPosition(page: Int, top: Int) {
        val intent = Intent("com.dictation.INSERT_POSITION").apply {
            putExtra("page", page)
            putExtra("top", top)
        }
        reactApplicationContext.sendBroadcast(intent)
    }

    @ReactMethod
    fun stopListening() {
        receiver?.let {
            reactApplicationContext.unregisterReceiver(it)
            receiver = null
        }
    }

    @ReactMethod
    fun launchRelayApp() {
        val intent = Intent().apply {
            setClassName("com.dictation.server", "com.dictation.server.MainActivity")
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        reactApplicationContext.startActivity(intent)
    }

    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}

    /**
     * CatalystInstance 销毁时（closePluginView 触发重建周期）主动注销 BroadcastReceiver。
     *
     * 不加这个的后果：
     *   - 旧 Module 实例的 receiver 字段被 GC，系统持有的 ReceiverRecord 变成悬空引用
     *   - 新 Module 实例 receiver=null，但 JS 侧 ensureInit() 因 _initialized=true 跳过
     *     BroadcastBridge.startListening()，导致 com.dictation.TEXT_TO_PLUGIN 广播永久丢失
     *
     * 修复后：新 Module 实例 receiver=null 且已完成清理，
     * reviveIfNeeded() / ensureInit() 调用 reviveBridge() 时可安全重新注册。
     */
    override fun onCatalystInstanceDestroy() {
        stopListening()
        Log.i("BroadcastBridge", "onCatalystInstanceDestroy — receiver unregistered")
        super.onCatalystInstanceDestroy()
    }
}
