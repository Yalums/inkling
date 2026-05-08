package com.supernote_quicktoolbar

import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * InklingCoreModule — RN ↔ native conversion bridge.
 *
 * M0 stub: pure-Kotlin fake timer that emits 4 progress stages
 * (parse / layout / render / package) then resolves with a fake output path.
 * M1 will replace the Handler chain with a JNI call into libinkling_jni.so.
 */
class InklingCoreModule(private val ctx: ReactApplicationContext)
    : ReactContextBaseJavaModule(ctx) {

    override fun getName(): String = "InklingCore"

    @ReactMethod
    fun convert(inputPath: String, outputPath: String, optionsJson: String,
                jobId: String, promise: Promise) {
        val main = Handler(Looper.getMainLooper())
        val stages = listOf(0, 1, 2, 3)  // parse, layout, render, package
        var i = 0
        fun tick() {
            if (i >= stages.size) {
                emit(jobId, 4, 100)  // done
                promise.resolve(outputPath)
                return
            }
            emit(jobId, stages[i], 100)
            i++
            main.postDelayed(::tick, 400)
        }
        main.postDelayed(::tick, 200)
    }

    private fun emit(jobId: String, stage: Int, percent: Int) {
        val map = Arguments.createMap().apply {
            putString("jobId", jobId)
            putInt("stage", stage)
            putInt("percent", percent)
        }
        ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("InklingProgress", map)
    }
}
