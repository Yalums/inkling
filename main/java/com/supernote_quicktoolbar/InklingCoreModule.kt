package com.supernote_quicktoolbar

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * InklingCoreModule — RN ↔ native conversion bridge.
 *
 * convert() dispatches the native call onto a worker thread (nativeConvert
 * blocks the caller while it walks the pipeline). Each stage callback from
 * C++ flows through InklingNative.ProgressListener and is republished on
 * the JS-side 'InklingProgress' DeviceEventEmitter channel.
 */
class InklingCoreModule(private val ctx: ReactApplicationContext)
    : ReactContextBaseJavaModule(ctx) {

    override fun getName(): String = "InklingCore"

    @ReactMethod
    fun convert(inputPath: String, outputPath: String, optionsJson: String,
                jobId: String, promise: Promise) {
        Thread({
            try {
                val listener = object : InklingNative.ProgressListener {
                    override fun onProgress(jobId: String, stage: Int, percent: Int) {
                        emit(jobId, stage, percent)
                    }
                }
                val rc = InklingNative.nativeConvert(
                    inputPath, outputPath, optionsJson, jobId, listener)
                if (rc == 0) {
                    promise.resolve(outputPath)
                } else {
                    promise.reject("INKLING_ERR_$rc", "ink_convert returned $rc")
                }
            } catch (t: Throwable) {
                promise.reject("INKLING_EXCEPTION", t)
            }
        }, "inkling-convert").start()
    }

    @ReactMethod
    fun nativeVersion(promise: Promise) {
        try {
            promise.resolve(InklingNative.nativeVersion())
        } catch (t: Throwable) {
            promise.reject("INKLING_EXCEPTION", t)
        }
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
