package com.supernote_quicktoolbar

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * FilePickerModule — opens SAF picker, copies the chosen URI into a sandbox
 * file, and returns the absolute path to JS.
 *
 * M0 stub: returns a fixed fake path so the placeholder UI flow can be
 * exercised end-to-end without filesystem permissions.
 * M1+ will wire this to ACTION_OPEN_DOCUMENT + ContentResolver.openInputStream.
 */
class FilePickerModule(ctx: ReactApplicationContext)
    : ReactContextBaseJavaModule(ctx) {

    override fun getName(): String = "FilePicker"

    @ReactMethod
    fun pickDocument(promise: Promise) {
        promise.resolve("/sdcard/Document/sample.md")
    }
}
