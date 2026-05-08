package com.supernote_quicktoolbar

import android.content.pm.ActivityInfo
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * OrientationModule — locks the host activity orientation while the plugin
 * view is up.
 *
 * Inkling default flow runs portrait. The advanced settings screen needs
 * landscape for its wider parameter form, so it calls lockLandscape()
 * on mount and unlock() on unmount.
 */
class OrientationModule(private val ctx: ReactApplicationContext)
    : ReactContextBaseJavaModule(ctx) {

    override fun getName(): String = "Orientation"

    @ReactMethod
    fun lockPortrait(promise: Promise) {
        runOnUi(promise) {
            it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        }
    }

    @ReactMethod
    fun lockLandscape(promise: Promise) {
        runOnUi(promise) {
            it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        }
    }

    @ReactMethod
    fun unlock(promise: Promise) {
        runOnUi(promise) {
            it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
    }

    private inline fun runOnUi(promise: Promise, crossinline f: (android.app.Activity) -> Unit) {
        val act = currentActivity
        if (act == null) {
            promise.reject("NO_ACTIVITY", "currentActivity is null")
            return
        }
        act.runOnUiThread {
            try {
                f(act)
                promise.resolve(true)
            } catch (t: Throwable) {
                promise.reject("ORIENTATION_ERR", t)
            }
        }
    }
}
