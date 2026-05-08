package com.supernote_quicktoolbar

/**
 * InklingNative — thin Kotlin facade over libinkling_jni.so.
 *
 * Lifecycle: System.loadLibrary runs once on class init; subsequent native
 * calls are direct. nativeConvert blocks the calling thread, so callers
 * (e.g. InklingCoreModule) must dispatch it off the main thread.
 *
 * The ProgressListener interface signature MUST match what
 * jni_bridge.cpp::progress_trampoline calls — String + int + int.
 */
object InklingNative {

    init { System.loadLibrary("inkling_jni") }

    interface ProgressListener {
        fun onProgress(jobId: String, stage: Int, percent: Int)
    }

    @JvmStatic
    external fun nativeConvert(
        inputPath: String,
        outputPath: String,
        optionsJson: String,
        jobId: String,
        listener: ProgressListener
    ): Int

    @JvmStatic
    external fun nativeVersion(): String
}
