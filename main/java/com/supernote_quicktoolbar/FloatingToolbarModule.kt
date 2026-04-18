package com.supernote_quicktoolbar

import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.util.TypedValue
import android.view.*
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONArray
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * FloatingToolbarModule — e-ink 系统级悬浮快捷工具栏
 *
 * 两种状态（参照 eink-toolbar-scheme4.jsx）：
 *   - 展开 (expanded): 完整工具网格 (2×2 / 3×2 / 4×2)，带侧边选中态指示条
 *   - 收纳 (collapsed): 贴边 6px 斑马纹指示条，高 50px
 *
 * 拖拽到屏幕边缘 → 自动收纳；点击指示条 → 展开。
 * 展开时拖拽手柄在靠屏幕边侧（left→左侧 4px 黑条, right→右侧 4px 黑条）。
 *
 * WindowManager TYPE_APPLICATION_OVERLAY 悬浮窗，closePluginView() 后仍存活。
 */
class FloatingToolbarModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "FloatingToolbar"

    companion object {
        private const val TAG = "FloatingToolbar"

        // ── 工具栏核心状态（静态，跨实例存活）──
        @Volatile @JvmStatic
        private var windowManager: WindowManager? = null
        @Volatile @JvmStatic
        private var rootView: View? = null
        @Volatile @JvmStatic
        private var layoutParams: WindowManager.LayoutParams? = null

        // 展开态引用
        @Volatile @JvmStatic
        private var expandedRoot: LinearLayout? = null
        @Volatile @JvmStatic
        private var toolContainer: GridLayout? = null

        // 收纳态引用
        @Volatile @JvmStatic
        private var collapsedRoot: View? = null

        @Volatile @JvmStatic
        private var collapsed: Boolean = false
        @Volatile @JvmStatic
        private var dockSide: String = "left"  // "left" | "right"
        @Volatile @JvmStatic
        private var tools: MutableList<ToolItem> = mutableListOf()
        @Volatile @JvmStatic
        private var activeToolIndex: Int = 0

        /** Set to true when the ☰ button is tapped; App.tsx reads & clears this on mount. */
        @Volatile @JvmStatic
        private var pendingOpenMain: Boolean = false

        @Volatile @JvmStatic
        private var pendingScreen: String = ""

        @Volatile @JvmStatic
        private var startX = 0
        @Volatile @JvmStatic
        private var startY = 0
        @Volatile @JvmStatic
        private var startRawX = 0f
        @Volatile @JvmStatic
        private var startRawY = 0f
        @Volatile @JvmStatic
        private var isDragging = false
        @Volatile @JvmStatic
        private var longPressTriggered = false

        @JvmStatic
        private var screenWidth = 1404
        @JvmStatic
        private var screenHeight = 1872

        // ── 前台检测状态 ──
        @Volatile @JvmStatic
        private var foregroundMonitorRunning = false
        @Volatile @JvmStatic
        private var wasVisibleBeforeBackground = false
        @Volatile @JvmStatic
        private var isInNoteApp = true

        // ── 截图遮罩（Bug 2/4 修复）──
        // 独立于 rootView 的全屏遮罩。用于在 handleScreenshotAi 的
        // forceClosePluginView → screencap → openPluginView 全程（约 2.2s）
        // 提供视觉反馈 + 阻挡误触（防止用户滑动切换到文档页面）。
        @Volatile @JvmStatic
        private var captureToastView: View? = null

        private const val NOTE_PACKAGE = "com.ratta.supernote.note"
        private const val MONITOR_INTERVAL_MS = 800L
    }

    private val handler = Handler(Looper.getMainLooper())

    private val longPressRunnable = Runnable {
        longPressTriggered = true
        callShowPluginView()
        emitEvent("onToolbarOpenMain", Arguments.createMap())
    }

    // ── JSX 设计规格 ──
    private val BTN_SIZE_DP = 38
    private val BTN_GAP_DP = 2
    private val PANEL_PAD_DP = 4
    private val BORDER_WIDTH = 2        // 1.5px → 2px for e-ink
    private val SIDE_INDICATOR_DP = 4   // 3.5px → 4px 侧边选中指示条
    private val HANDLE_WIDTH_DP = 4     // 展开态手柄宽度
    private val COLLAPSED_WIDTH_DP = 6  // 收纳态指示条宽度
    private val COLLAPSED_HEIGHT_DP = 50 // 收纳态指示条高度
    private val BTN_TEXT_SIZE_SP = 14f
    private val CORNER_RADIUS_DP = 6f

    private val SNAP_THRESHOLD = 40
    private val EDGE_COLLAPSE_THRESHOLD = 60  // 拖拽到边缘多近时自动收纳
    private val LONG_PRESS_MS = 600L

    data class ToolItem(val id: String, val name: String, val icon: String, val action: String)

    // ════════════════════════════════════════════
    //  @ReactMethod
    // ════════════════════════════════════════════

    @ReactMethod
    fun show(toolsJson: String) {
        handler.post {
            try {
                parseTools(toolsJson)
                collapsed = false
                removeAll()
                createExpandedToolbar()
                startForegroundMonitor()
            } catch (e: Exception) { Log.e(TAG, "show: ${e.message}", e) }
        }
    }

    @ReactMethod
    fun hide() {
        handler.post { try { removeAll() } catch (e: Exception) { Log.e(TAG, "hide: ${e.message}", e) } }
    }

    @ReactMethod
    fun updateTools(toolsJson: String) {
        handler.post {
            parseTools(toolsJson)
            if (!collapsed && expandedRoot != null) {
                rebuildButtons()
            }
        }
    }

    @ReactMethod
    fun collapse() {
        handler.post { switchToCollapsed() }
    }

    @ReactMethod
    fun expand() {
        handler.post { switchToExpanded() }
    }

    @ReactMethod
    fun setSide(side: String) {
        handler.post {
            dockSide = if (side == "right") "right" else "left"
            if (collapsed) {
                removeAll()
                createCollapsedHandle()
            } else if (expandedRoot != null) {
                // 重建以更新圆角和指示条方向
                removeAll()
                createExpandedToolbar()
            }
        }
    }

    @ReactMethod
    fun setCollapsed(value: Boolean) {
        handler.post {
            if (value) switchToCollapsed() else switchToExpanded()
        }
    }

    @ReactMethod fun isShowing(promise: Promise) { promise.resolve(rootView != null) }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun isShowingSync(): Boolean = rootView != null

    @ReactMethod
    fun checkPendingOpenMain(promise: Promise) {
        val v = pendingOpenMain
        pendingOpenMain = false
        promise.resolve(v)
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun checkPendingOpenMainSync(): Boolean = pendingOpenMain

    @ReactMethod
    fun ackOpenMain() { pendingOpenMain = false }

    @ReactMethod
    fun setPendingScreen(name: String) { pendingScreen = name ?: "" }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getPendingScreenSync(): String = pendingScreen

    @ReactMethod
    fun ackPendingScreen() {
        Log.i(TAG, "[LASSO-DBG/Kt] ackPendingScreen (was=$pendingScreen)")
        pendingScreen = ""
    }

    @ReactMethod
    fun openPluginView() {
        handler.post {
            Log.i(TAG, "[LASSO-DBG/Kt] openPluginView called (pendingScreen=$pendingScreen)")
            try { callShowPluginView() } catch (e: Exception) {
                Log.e(TAG, "[LASSO-DBG/Kt] openPluginView FAIL: ${e.message}")
            }
        }
    }

    @ReactMethod
    fun openPanel(screen: String) {
        handler.post {
            Log.i(TAG, "[LASSO-DBG/Kt] openPanel screen=$screen (prev pendingScreen=$pendingScreen)")
            pendingScreen = screen ?: ""
            removeAll()
            emitEvent("onToolbarOpenMain", Arguments.createMap())
            Log.i(TAG, "[LASSO-DBG/Kt] openPanel done, pendingScreen now=$pendingScreen")
        }
    }

    /**
     * Force-close plugin view via NativePluginManager reflection.
     * Unlike PluginManager.closePluginView() from sn-plugin-lib (which checks PluginApp state
     * and does nothing when state=='stop'), this directly calls the underlying native method.
     */
    @ReactMethod
    fun forceClosePluginView() {
        handler.post {
            Log.i(TAG, "[LASSO-DBG/Kt] forceClosePluginView called")
            callClosePluginView()
        }
    }

    // ════════════════════════════════════════════
    //  截图遮罩（Bug 2/4：lasso 截屏期间的视觉反馈 + 误触阻挡）
    // ════════════════════════════════════════════

    /**
     * 显示居中的 "截图中…" 小气泡指示器。
     *
     * 关键设计约束（踩过的坑）：
     *   - 必须 WRAP_CONTENT，不能 MATCH_PARENT：在某些 Supernote 固件上，
     *     全屏 TYPE_APPLICATION_OVERLAY 遮罩会让 plugin view 的 RN view
     *     在 remove 后无法正常 re-attach（SliderProgressView 接管屏幕，
     *     笔事件落回 NoteLongPressDetector），导致 lasso UI 不可见。
     *   - 必须 FLAG_NOT_TOUCHABLE：不消费任何触摸，让下方的 plugin view
     *     或 NOTE 正常接收事件。代价是无法阻挡 Bug 4 的误触，但 Bug 2
     *     的视觉反馈是主要目标，Bug 4 容忍。
     *   - 重复调用幂等：已显示时仅更新文字。
     */
    @ReactMethod
    fun showCaptureToast(message: String?) {
        handler.post {
            try {
                val ctx = reactApplicationContext
                val text = if (message.isNullOrBlank()) "截图中…" else message

                // 幂等：已显示则只更新文字（复用 TextView）
                captureToastView?.let { existing ->
                    (existing as? TextView)?.text = text
                    Log.i(TAG, "[LASSO-DBG/Kt] showCaptureToast already showing, text updated")
                    return@post
                }

                val wm = ctx.getSystemService(android.content.Context.WINDOW_SERVICE) as WindowManager

                // 居中小气泡：圆角黑底白字，不占全屏，不消费触摸
                val toast = TextView(ctx).apply {
                    this.text = text
                    setTextColor(Color.WHITE)
                    setTypeface(Typeface.DEFAULT_BOLD)
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
                    val padH = dpToPx(28); val padV = dpToPx(16)
                    setPadding(padH, padV, padH, padV)
                    background = GradientDrawable().apply {
                        cornerRadius = dpToPx(12).toFloat()
                        setColor(0xE6000000.toInt())  // 接近不透明的黑
                        setStroke(dpToPx(1), 0xFFFFFFFF.toInt())
                    }
                }

                val wmType = if (Build.VERSION.SDK_INT >= 26)
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE

                // 关键：WRAP_CONTENT + FLAG_NOT_TOUCHABLE + FLAG_NOT_FOCUSABLE
                // overlay 只占文字大小，不会遮挡 plugin view 的任何区域。
                val lp = WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    wmType,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                        WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                    PixelFormat.TRANSLUCENT
                ).apply {
                    gravity = Gravity.CENTER
                    x = 0; y = 0
                }

                wm.addView(toast, lp)
                captureToastView = toast
                Log.i(TAG, "[LASSO-DBG/Kt] showCaptureToast shown: '$text'")
            } catch (e: Exception) {
                Log.e(TAG, "[LASSO-DBG/Kt] showCaptureToast FAIL: ${e.message}", e)
            }
        }
    }

    @ReactMethod
    fun hideCaptureToast() {
        handler.post {
            val v = captureToastView ?: return@post
            try {
                val wm = reactApplicationContext.getSystemService(android.content.Context.WINDOW_SERVICE) as WindowManager
                wm.removeView(v)
                Log.i(TAG, "[LASSO-DBG/Kt] hideCaptureToast removed")
            } catch (e: Exception) {
                Log.w(TAG, "[LASSO-DBG/Kt] hideCaptureToast: ${e.message}")
            } finally {
                captureToastView = null
            }
        }
    }

    @ReactMethod
    fun savePreset(num: Int, json: String, promise: Promise) {
        try {
            val prefs = reactApplicationContext.getSharedPreferences("quicktoolbar_presets", 0)
            prefs.edit().putString("preset_$num", json).apply()
            promise.resolve(true)
        } catch (e: Exception) {
            Log.e(TAG, "savePreset: ${e.message}")
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun loadPreset(num: Int, promise: Promise) {
        try {
            val prefs = reactApplicationContext.getSharedPreferences("quicktoolbar_presets", 0)
            val json = prefs.getString("preset_$num", null)
            promise.resolve(json)
        } catch (e: Exception) {
            Log.e(TAG, "loadPreset: ${e.message}")
            promise.resolve(null)
        }
    }

    /**
     * 返回插件私有的 sticker 存储目录（不会被用户误删）。
     * 路径: /sdcard/Android/data/<packageName>/files/stickers/
     * NOTE 通过文件系统路径可读取此目录下的文件。
     */
    @ReactMethod
    fun getStickerDir(promise: Promise) {
        try {
            val dir = java.io.File(reactApplicationContext.getExternalFilesDir(null), "stickers")
            promise.resolve(dir.absolutePath)
        } catch (e: Exception) {
            Log.e(TAG, "getStickerDir: ${e.message}")
            promise.resolve(null)
        }
    }

    /**
     * 确保 sticker 目录存在（创建目录 + 所有父目录），返回路径。
     * 在每次 saveStickerByLasso 前调用，防止目录被删后静默失败。
     */
    @ReactMethod
    fun ensureStickerDir(promise: Promise) {
        try {
            val dir = java.io.File(reactApplicationContext.getExternalFilesDir(null), "stickers")
            if (!dir.exists()) {
                val ok = dir.mkdirs()
                Log.i(TAG, "ensureStickerDir: mkdirs=${ok} path=${dir.absolutePath}")
            }
            promise.resolve(dir.absolutePath)
        } catch (e: Exception) {
            Log.e(TAG, "ensureStickerDir: ${e.message}")
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun checkOverlayPermission(promise: Promise) {
        if (Build.VERSION.SDK_INT >= 23) promise.resolve(Settings.canDrawOverlays(reactApplicationContext))
        else promise.resolve(true)
    }

    @ReactMethod
    fun deleteQueueFile(path: String, promise: Promise) {
        try {
            val f = java.io.File(path)
            if (f.exists()) {
                val deleted = f.delete()
                Log.i(TAG, "[INSERT-DBG/Kt] deleteQueueFile: $path → deleted=$deleted")
                promise.resolve(deleted)
            } else {
                Log.i(TAG, "[INSERT-DBG/Kt] deleteQueueFile: $path already gone")
                promise.resolve(false)
            }
        } catch (e: Exception) {
            Log.e(TAG, "[INSERT-DBG/Kt] deleteQueueFile error: ${e.message}")
            promise.reject("DELETE_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun requestOverlayPermission() {
        try {
            val ctx = reactApplicationContext
            ctx.startActivity(android.content.Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                android.net.Uri.parse("package:${ctx.packageName}")
            ).apply { addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK) })
        } catch (e: Exception) {
            Log.e(TAG, "requestOverlayPermission: ${e.message}", e)
            try {
                reactApplicationContext.startActivity(android.content.Intent(
                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    android.net.Uri.parse("package:${reactApplicationContext.packageName}")
                ).apply { addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK) })
            } catch (_: Exception) {}
        }
    }

    private fun callShowPluginView() {
        try {
            val catalyst = reactApplicationContext.catalystInstance
            val pluginManager = catalyst.getNativeModule("NativePluginManager") ?: return
            val allMethods = pluginManager::class.java.methods.filter { it.name == "showPluginView" }
            if (allMethods.isEmpty()) return
            val noArgMethod = allMethods.firstOrNull { it.parameterCount == 0 }
            if (noArgMethod != null) { noArgMethod.invoke(pluginManager); return }
            val singleArgMethod = allMethods.firstOrNull { it.parameterCount == 1 }
            if (singleArgMethod != null) { singleArgMethod.invoke(pluginManager, null as Any?); return }
            val fallback = allMethods.first()
            val args = arrayOfNulls<Any>(fallback.parameterCount)
            fallback.invoke(pluginManager, *args)
        } catch (e: Exception) { Log.e(TAG, "callShowPluginView: ${e.message}", e) }
    }

    /**
     * 通过反射直接关闭 plugin view（不依赖 JS bridge，更可靠）。
     * 尝试 closePluginView / hidePluginView 两种方法名。
     */
    private fun callClosePluginView() {
        try {
            val catalyst = reactApplicationContext.catalystInstance
            val pluginManager = catalyst.getNativeModule("NativePluginManager") ?: return
            for (name in arrayOf("closePluginView", "hidePluginView")) {
                val methods = pluginManager::class.java.methods.filter { it.name == name }
                if (methods.isEmpty()) continue
                val noArg = methods.firstOrNull { it.parameterCount == 0 }
                if (noArg != null) { noArg.invoke(pluginManager); Log.i(TAG, "$name() called"); return }
                val singleArg = methods.firstOrNull { it.parameterCount == 1 }
                if (singleArg != null) { singleArg.invoke(pluginManager, null as Any?); Log.i(TAG, "$name(null) called"); return }
            }
            Log.w(TAG, "callClosePluginView: no suitable method found")
        } catch (e: Exception) { Log.e(TAG, "callClosePluginView: ${e.message}", e) }
    }

    // ════════════════════════════════════════════
    //  状态切换
    // ════════════════════════════════════════════

    private fun switchToCollapsed() {
        if (collapsed && collapsedRoot != null) return
        collapsed = true
        removeAll()
        createCollapsedHandle()
        emitCollapseChange()
    }

    private fun switchToExpanded() {
        if (!collapsed && expandedRoot != null) return
        collapsed = false
        removeAll()
        createExpandedToolbar()
        emitCollapseChange()
    }

    private fun emitCollapseChange() {
        emitEvent("onToolbarCollapseChange", Arguments.createMap().apply {
            putBoolean("collapsed", collapsed)
            putString("side", dockSide)
        })
    }

    // ════════════════════════════════════════════
    //  收纳态：斑马纹指示条
    // ════════════════════════════════════════════

    private fun createCollapsedHandle() {
        val ctx = reactApplicationContext
        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(ctx)) {
            emitEvent("onToolbarPermissionDenied", Arguments.createMap()); return
        }

        windowManager = ctx.getSystemService(android.content.Context.WINDOW_SERVICE) as WindowManager
        val dm = ctx.resources.displayMetrics
        screenWidth = dm.widthPixels; screenHeight = dm.heightPixels

        val w = dpToPx(COLLAPSED_WIDTH_DP)
        val h = dpToPx(COLLAPSED_HEIGHT_DP)

        // 斑马纹 View
        collapsedRoot = View(ctx).apply {
            background = object : android.graphics.drawable.Drawable() {
                private val paint = android.graphics.Paint().apply { isAntiAlias = false }
                override fun draw(canvas: android.graphics.Canvas) {
                    val b = bounds
                    val stripeH = dpToPx(4).toFloat()
                    var y = 0f
                    var dark = true
                    while (y < b.height()) {
                        paint.color = if (dark) Color.parseColor("#666666") else Color.parseColor("#AAAAAA")
                        canvas.drawRect(0f, y, b.width().toFloat(), (y + stripeH).coerceAtMost(b.height().toFloat()), paint)
                        y += stripeH
                        dark = !dark
                    }
                }
                override fun setAlpha(a: Int) {}
                override fun setColorFilter(cf: android.graphics.ColorFilter?) {}
                @Deprecated("deprecated") override fun getOpacity() = PixelFormat.OPAQUE
            }
            // 圆角：靠屏幕侧直角，外侧圆角
            val clip = GradientDrawable().apply {
                setColor(Color.TRANSPARENT)
                if (dockSide == "left") {
                    cornerRadii = floatArrayOf(0f,0f, dpToPx(2).toFloat(),dpToPx(2).toFloat(),
                        dpToPx(2).toFloat(),dpToPx(2).toFloat(), 0f,0f)
                } else {
                    cornerRadii = floatArrayOf(dpToPx(2).toFloat(),dpToPx(2).toFloat(), 0f,0f,
                        0f,0f, dpToPx(2).toFloat(),dpToPx(2).toFloat())
                }
            }
            clipToOutline = true
            outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(view: View, outline: android.graphics.Outline) {
                    if (dockSide == "left") {
                        outline.setRoundRect(0, 0, view.width, view.height, dpToPx(2).toFloat())
                    } else {
                        outline.setRoundRect(0, 0, view.width, view.height, dpToPx(2).toFloat())
                    }
                }
            }
        }

        val wmType = if (Build.VERSION.SDK_INT >= 26)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE

        layoutParams = WindowManager.LayoutParams(
            w, h, wmType,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = if (dockSide == "left") 0 else screenWidth - w
            y = screenHeight / 2 - h / 2
        }

        // 点击 → 展开; 长按 → 销毁整个插件
        val collapsedLongPressRunnable = Runnable {
            longPressTriggered = true
            // 长按收纳条 → 销毁所有悬浮窗 + 关闭插件
            destroyAll()
        }
        collapsedRoot!!.setOnTouchListener { _, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    startRawX = event.rawX; startRawY = event.rawY
                    isDragging = false; longPressTriggered = false
                    handler.postDelayed(collapsedLongPressRunnable, LONG_PRESS_MS)
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - startRawX; val dy = event.rawY - startRawY
                    if (!isDragging && (abs(dx) > 10 || abs(dy) > 10)) {
                        isDragging = true
                        handler.removeCallbacks(collapsedLongPressRunnable)
                    }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    handler.removeCallbacks(collapsedLongPressRunnable)
                    if (!isDragging && !longPressTriggered) {
                        switchToExpanded()
                    }
                    true
                }
                MotionEvent.ACTION_CANCEL -> {
                    handler.removeCallbacks(collapsedLongPressRunnable)
                    true
                }
                else -> false
            }
        }

        rootView = collapsedRoot
        windowManager?.addView(rootView, layoutParams)
        Log.i(TAG, "collapsed handle shown, side=$dockSide")
    }

    // ════════════════════════════════════════════
    //  展开态：完整工具栏网格
    // ════════════════════════════════════════════

    private fun createExpandedToolbar() {
        val ctx = reactApplicationContext
        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(ctx)) {
            emitEvent("onToolbarPermissionDenied", Arguments.createMap()); return
        }

        windowManager = ctx.getSystemService(android.content.Context.WINDOW_SERVICE) as WindowManager
        val dm = ctx.resources.displayMetrics
        screenWidth = dm.widthPixels; screenHeight = dm.heightPixels

        val pad = dpToPx(PANEL_PAD_DP)
        val isLeft = dockSide == "left"
        val cornerR = dpToPx(CORNER_RADIUS_DP.toInt()).toFloat()

        expandedRoot = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(pad, pad, pad, pad)
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#F5F5F5"))
                setStroke(dpToPx(BORDER_WIDTH) / 2 + 1, Color.parseColor("#444444"))
                // 靠屏幕侧直角，外侧圆角
                cornerRadii = if (isLeft)
                    floatArrayOf(0f, 0f, cornerR, cornerR, cornerR, cornerR, 0f, 0f)
                else
                    floatArrayOf(cornerR, cornerR, 0f, 0f, 0f, 0f, cornerR, cornerR)
            }
        }

        // 手柄 (4px宽黑条) —— 靠屏幕边的一侧
        val handleW = dpToPx(HANDLE_WIDTH_DP)
        val handleView = View(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(handleW, LinearLayout.LayoutParams.MATCH_PARENT).apply {
                if (isLeft) rightMargin = dpToPx(2) else leftMargin = dpToPx(2)
            }
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#444444"))
                cornerRadius = dpToPx(2).toFloat()
            }
        }

        // 工具网格
        val layout = calcLayout()
        toolContainer = GridLayout(ctx).apply {
            columnCount = layout.first
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
            )
        }

        rebuildButtons()

        // 组装：手柄在靠屏幕侧
        if (isLeft) {
            expandedRoot!!.addView(handleView)
            expandedRoot!!.addView(toolContainer)
        } else {
            expandedRoot!!.addView(toolContainer)
            expandedRoot!!.addView(handleView)
        }

        val wmType = if (Build.VERSION.SDK_INT >= 26)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE

        layoutParams = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
            wmType,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = if (isLeft) 0 else (screenWidth - dpToPx(200))  // 会被 snapToEdge 修正
            y = screenHeight / 2 - dpToPx(60)
        }

        // 拖拽 + 长按
        expandedRoot!!.setOnTouchListener { _, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    val lp = layoutParams ?: return@setOnTouchListener false
                    startX = lp.x; startY = lp.y
                    startRawX = event.rawX; startRawY = event.rawY
                    isDragging = false; longPressTriggered = false
                    handler.postDelayed(longPressRunnable, LONG_PRESS_MS)
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val lp = layoutParams ?: return@setOnTouchListener false
                    val dx = event.rawX - startRawX; val dy = event.rawY - startRawY
                    if (!isDragging && (abs(dx) > 10 || abs(dy) > 10)) {
                        isDragging = true
                        handler.removeCallbacks(longPressRunnable)
                    }
                    if (isDragging) {
                        lp.x = startX + dx.toInt()
                        lp.y = startY + dy.toInt()
                        try { windowManager?.updateViewLayout(rootView, lp) } catch (_: Exception) {}
                    }; true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    handler.removeCallbacks(longPressRunnable)
                    if (isDragging) {
                        // 拖拽到边缘 → 自动收纳
                        val lp = layoutParams ?: return@setOnTouchListener true
                        val vw = expandedRoot?.measuredWidth ?: 0
                        if (lp.x <= EDGE_COLLAPSE_THRESHOLD) {
                            dockSide = "left"
                            switchToCollapsed()
                        } else if (screenWidth - (lp.x + vw) <= EDGE_COLLAPSE_THRESHOLD) {
                            dockSide = "right"
                            switchToCollapsed()
                        } else {
                            snapToEdge()
                            emitEvent("onToolbarDragEnd", Arguments.createMap().apply {
                                putInt("x", layoutParams!!.x); putInt("y", layoutParams!!.y)
                            })
                        }
                    } else if (!longPressTriggered) {
                        emitEvent("onToolbarTap", Arguments.createMap())
                    }; true
                }
                else -> false
            }
        }

        rootView = expandedRoot
        windowManager?.addView(rootView, layoutParams)

        // 确保贴边
        handler.postDelayed({
            if (!collapsed && expandedRoot != null) {
                if (isLeft) layoutParams?.x = 0
                else {
                    val vw = expandedRoot?.measuredWidth ?: 0
                    if (vw > 0) layoutParams?.x = screenWidth - vw
                }
                try { windowManager?.updateViewLayout(rootView, layoutParams) } catch (_: Exception) {}
            }
        }, 50)

        Log.i(TAG, "expanded toolbar shown, ${tools.size} tools, side=$dockSide")
    }

    // ════════════════════════════════════════════
    //  按钮渲染 (e-ink 高对比 + 侧边指示条)
    // ════════════════════════════════════════════

    private fun rebuildButtons() {
        val c = toolContainer ?: return
        c.removeAllViews()

        val layout = calcLayout()
        c.columnCount = layout.first
        val cols = layout.first
        val isLeft = dockSide == "left"

        val btnSz = dpToPx(BTN_SIZE_DP); val mg = dpToPx(BTN_GAP_DP) / 2
        val indicatorW = dpToPx(SIDE_INDICATOR_DP)
        val mHandler = handler

        // ── 收纳/菜单按钮 (☰) ──
        val toggleBtn = TextView(reactApplicationContext).apply {
            text = "\u2630"  // ☰
            setTextSize(TypedValue.COMPLEX_UNIT_SP, BTN_TEXT_SIZE_SP)
            setTextColor(Color.BLACK); typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                setColor(Color.WHITE); setStroke(2, Color.BLACK); cornerRadius = 3f
            }
            layoutParams = GridLayout.LayoutParams().apply {
                width = btnSz; height = btnSz; setMargins(mg, mg, mg, mg)
            }
            setOnClickListener {
                (background as? GradientDrawable)?.setColor(Color.BLACK); setTextColor(Color.WHITE)
                mHandler.postDelayed({
                    // ☰ → 收纳到屏幕边缘（不再打开 React 主面板）
                    switchToCollapsed()
                }, 200)
            }
        }
        c.addView(toggleBtn)

        // ── 工具列表 ──
        for ((idx, tool) in tools.withIndex()) {
            val isActive = idx == activeToolIndex
            val col = (idx + 1) % cols  // +1 因为 ☰ 占第一格
            val btnIdx = idx + 1

            val btn = TextView(reactApplicationContext).apply {
                text = tool.icon
                setTextSize(TypedValue.COMPLEX_UNIT_SP, BTN_TEXT_SIZE_SP)
                setTextColor(if (isActive) Color.BLACK else Color.parseColor("#666666"))
                typeface = Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
                background = GradientDrawable().apply {
                    setColor(if (isActive) Color.parseColor("#DDDDDD") else Color.TRANSPARENT)
                    setStroke(2, Color.BLACK); cornerRadius = 3f
                }

                // 侧边指示条：靠屏幕一侧的列显示
                val gridCol = btnIdx % cols
                val showIndicator = if (isLeft) gridCol == 0 else gridCol == cols - 1
                val indicatorPad = if (showIndicator && isActive) indicatorW else 0

                layoutParams = GridLayout.LayoutParams().apply {
                    width = btnSz; height = btnSz; setMargins(mg, mg, mg, mg)
                    if (showIndicator && isActive) {
                        if (isLeft) leftMargin = mg + indicatorW / 2
                        else rightMargin = mg + indicatorW / 2
                    }
                }

                // 捕获模块 handler：View.apply{} 内裸写 `handler` 会解析为 View.getHandler()，
                // detach 后返回 null 导致 postDelayed NPE
                val moduleHandler = this@FloatingToolbarModule.handler
                setOnClickListener {
                    activeToolIndex = idx
                    (background as? GradientDrawable)?.setColor(Color.BLACK); setTextColor(Color.WHITE)
                    moduleHandler.postDelayed({
                        rebuildButtons()  // 重建以更新选中态
                    }, 200)

                    val isTextMode = tool.action == "text_recv_nospacing" || tool.action == "text_recv_paragraph"
                    val isNativePanel = tool.action == "insert_image" || tool.action == "insert_doc_screenshot" || tool.action == "lasso_send" || isTextMode

                    if (isNativePanel) {
                        // isTextMode：不提前移除工具栏。
                        // 成功时 JS 的 modeSub 会触发 FloatingToolbarBridge.hide() + 气泡 show()。
                        // 失败时 insertModeChanged(null) 会尝试恢复工具栏。
                        // 若此处直接 removeAll()，失败后工具栏无法恢复，用户看到一片空白。
                        if (!isTextMode) removeAll()
                        when {
                            tool.action == "insert_image" -> {
                                // 纯 overlay，不打开 plugin view
                                NativeImagePanel.getInstance(reactApplicationContext, this@FloatingToolbarModule).show()
                            }
                            tool.action == "insert_doc_screenshot" -> {
                                // Check queue first: if has images, insert directly without opening panel
                                val queueDir = java.io.File("/sdcard/SCREENSHOT/.plugin_staging/queue")
                                val queueFiles = (queueDir.listFiles() ?: emptyArray())
                                    .filter { it.name.endsWith(".png") }
                                    .sortedByDescending { it.name.removeSuffix(".png").toLongOrNull() ?: 0L }
                                if (queueFiles.isNotEmpty()) {
                                    val nextPath = queueFiles.first().absolutePath
                                    Log.i(TAG, "[INSERT-DBG/Kt] direct insert from queue: $nextPath (queue has ${queueFiles.size} files)")
                                    // DO NOT delete file here — insertImage is async, file must exist
                                    // when JS side calls PluginNoteAPI.insertImage. JS will request
                                    // delete after insert success via nativeDeleteQueueFile event.
                                    // Delay to let pen-up event finish — avoids PluginHost NPE
                                    moduleHandler.postDelayed({
                                        try {
                                            requestInsertImage(nextPath)
                                        } catch (e: Exception) {
                                            Log.e(TAG, "requestInsertImage failed: ${e.message}")
                                            restoreToolbar()
                                        }
                                    }, 500)
                                } else {
                                    // Queue empty → open history panel
                                    NativeScreenshotPanel.getInstance(reactApplicationContext, this@FloatingToolbarModule).show()
                                }
                            }
                            tool.action == "lasso_send" -> {
                                pendingScreen = "nativeSendHelper"
                                NativeSendPanel.getInstance(reactApplicationContext, this@FloatingToolbarModule).show()
                                moduleHandler.postDelayed({
                                    callShowPluginView()
                                    val retryDelays = longArrayOf(50, 250, 750, 1500, 2500)
                                    for (delay in retryDelays) {
                                        moduleHandler.postDelayed({
                                            if (pendingScreen == "nativeSendHelper") {
                                                emitEvent("onToolbarOpenMain", Arguments.createMap())
                                            }
                                        }, delay)
                                    }
                                }, 150)
                            }
                            isTextMode -> {
                                // SDK 调用（getPageSize 等）需要活跃的 plugin session。
                                // 通过 openPanel 机制打开 plugin view，JS 稳定后执行 toggleMode。
                                // 注意：retryDelays 首次延迟 400ms，确保 ackPendingScreen() 在
                                // 第一次 retry 之前已被 JS 处理完毕（避免 pendingScreen 被误清空前重入）。
                                val actionKey = "action:${tool.action}"
                                pendingScreen = actionKey
                                moduleHandler.postDelayed({
                                    callShowPluginView()
                                    val retryDelays = longArrayOf(400, 900, 1800, 3000)
                                    for (delay in retryDelays) {
                                        moduleHandler.postDelayed({
                                            if (pendingScreen == actionKey) {
                                                emitEvent("onToolbarOpenMain", Arguments.createMap())
                                            }
                                        }, delay)
                                    }
                                }, 100)
                            }
                        }
                    } else {
                        emitEvent("onToolTap", Arguments.createMap().apply {
                            putString("toolId", tool.id); putString("toolAction", tool.action)
                            putString("toolName", tool.name)
                        })
                    }
                }
                setOnLongClickListener {
                    emitEvent("onToolLongPress", Arguments.createMap().apply {
                        putString("toolId", tool.id); putString("toolName", tool.name)
                    }); true
                }
            }
            c.addView(btn)
        }

        try {
            windowManager?.updateViewLayout(rootView, layoutParams)
        } catch (_: Exception) {}
    }

    // ════════════════════════════════════════════
    //  布局计算 + 吸附
    // ════════════════════════════════════════════

    /** 根据工具数量计算网格布局 [cols, rows]（☰ 已算入 totalCount）
     *  JS 工具数 → 总格数(含☰) → 布局
     *  5 → 6  → 3×2
     *  7 → 8  → 4×2
     *  8 → 9  → 3×3
     *  11 → 12 → 4×3
     */
    private fun calcLayout(): Pair<Int, Int> {
        val totalCount = tools.size + 1  // +1 for ☰
        return when {
            totalCount <= 6  -> Pair(3, 2)
            totalCount <= 8  -> Pair(4, 2)
            totalCount <= 9  -> Pair(3, 3)
            else             -> Pair(4, 3)
        }
    }

    private fun snapToEdge() {
        val lp = layoutParams ?: return; val root = rootView ?: return
        val vw = root.measuredWidth.takeIf { it > 0 } ?: root.width
        val vh = root.measuredHeight.takeIf { it > 0 } ?: root.height
        if (vw <= 0 || vh <= 0) return
        val cx = lp.x + vw / 2

        if (lp.x < SNAP_THRESHOLD) lp.x = 0
        else if (screenWidth - (lp.x + vw) < SNAP_THRESHOLD) lp.x = screenWidth - vw
        else if (abs(cx - screenWidth / 2) < SNAP_THRESHOLD) lp.x = screenWidth / 2 - vw / 2

        if (lp.y < SNAP_THRESHOLD) lp.y = 0
        else if (screenHeight - (lp.y + vh) < SNAP_THRESHOLD) lp.y = screenHeight - vh

        lp.x = lp.x.coerceIn(0, (screenWidth - vw).coerceAtLeast(0))
        lp.y = lp.y.coerceIn(0, (screenHeight - vh).coerceAtLeast(0))
        try { windowManager?.updateViewLayout(rootView, lp) } catch (_: Exception) {}
    }

    // ════════════════════════════════════════════
    //  工具 & 清理
    // ════════════════════════════════════════════

    private fun parseTools(json: String) {
        tools.clear()
        try {
            val arr = JSONArray(json)
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                tools.add(ToolItem(o.getString("id"), o.optString("name",""),
                    o.optString("icon","?"), o.optString("action","")))
            }
        } catch (e: Exception) { Log.e(TAG, "parseTools: ${e.message}") }
    }

    private fun removeAll() {
        if (rootView != null) {
            try { windowManager?.removeView(rootView) } catch (_: Exception) {}
            rootView = null
        }
        expandedRoot = null; toolContainer = null; collapsedRoot = null; layoutParams = null
    }

    private fun dpToPx(dp: Int): Int = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, dp.toFloat(), reactApplicationContext.resources.displayMetrics
    ).roundToInt()

    private fun emitEvent(name: String, params: WritableMap) {
        try {
            reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(name, params)
        } catch (e: Exception) { Log.w(TAG, "emitEvent($name): ${e.message}") }
    }

    override fun onCatalystInstanceDestroy() {
        Log.i(TAG, "onCatalystInstanceDestroy — keeping toolbar alive (rootView=${rootView != null})")
        super.onCatalystInstanceDestroy()
    }

    // ════════════════════════════════════════════
    //  Native panel helpers (exposed to NativeImagePanel / NativeSendPanel)
    // ════════════════════════════════════════════

    /** 提供给 native 面板调用，通过 JS bridge 执行 PluginNoteAPI.insertImage */
    fun requestInsertImage(path: String) {
        handler.post {
            // 短暂打开 plugin view 以激活 PluginNoteAPI
            pendingScreen = "nativeInsertHelper"
            callShowPluginView()

            // nativeInsertImage 的 retry 不能依赖 pendingScreen：
            // App.tsx 一挂载就调 ackPendingScreen() 清空 pendingScreen，导致
            // 依赖 pendingScreen==... 条件的 retry 永远 false，图片从不插入。
            // 改为无条件重试（前 2 次），App.tsx 收到第一次后立刻调 closePluginView()，
            // 后续 retry 到达时 bridge 已冻结，天然不会重复执行。
            val retryDelays = longArrayOf(300, 750)
            for (delay in retryDelays) {
                handler.postDelayed({
                    emitEvent("nativeInsertImage", Arguments.createMap().apply {
                        putString("path", path)
                    })
                }, delay)
            }
            // 安全网：关闭 plugin view + 恢复工具栏
            // JS 侧 nativeInsertImage 收到后 2500ms 才 closePluginView，
            // native 安全网必须等到 JS 自己关闭完毕之后才兜底（否则抢在前面关闭会丢弃插入）
            handler.postDelayed({
                pendingScreen = ""
                callClosePluginView()
            }, 5000)
            handler.postDelayed({
                restoreToolbar()
            }, 5500)
        }
    }

    /** 关闭 native 面板后恢复悬浮工具栏 */
    fun restoreToolbar() {
        handler.post {
            if (tools.isNotEmpty()) {
                collapsed = false
                removeAll()
                createExpandedToolbar()
            }
        }
    }

    /** 关闭 plugin view（直接 native 反射，不依赖 JS bridge） */
    fun requestClosePluginView() {
        handler.post {
            callClosePluginView()
        }
    }

    /** Called by JS after lasso extraction — passes data to NativeSendPanel */
    @ReactMethod
    fun setLassoData(text: String, imagePathsJson: String) {
        handler.post {
            val panel = NativeSendPanel.currentInstance
            if (panel != null) {
                val paths = mutableListOf<String>()
                try {
                    val arr = JSONArray(imagePathsJson)
                    for (i in 0 until arr.length()) paths.add(arr.getString(i))
                } catch (_: Exception) {}
                panel.updateLassoData(text, paths)
            }
            pendingScreen = ""
        }
    }

    /** Show native image panel (called from JS, e.g. bubble tap) */
    @ReactMethod
    fun showNativeImagePanel() {
        handler.post {
            removeAll()
            NativeImagePanel.getInstance(reactApplicationContext, this@FloatingToolbarModule).show()
        }
    }

    /**
     * 从文本气泡触发 lasso_send：复制工具栏按钮分支的完整序列。
     *   1. 立即显示 NativeSendPanel（WindowManager overlay，不依赖 plugin view）
     *   2. 延迟 150ms 后打开 plugin view，让 JS 跑 LassoExtractor.extract()
     *   3. 多次 emit onToolbarOpenMain，保证 App.tsx mount 时能消费 pendingScreen
     *
     * 和工具栏按钮路径的唯一差别：cameFromBubble=true，面板关闭时 emit onNativePanelClose
     * 而不是 restoreToolbar()（因为此时工具栏本就是隐藏的，需恢复气泡而非工具栏）。
     */
    @ReactMethod
    fun showNativeSendPanelFromBubble() {
        handler.post {
            Log.i(TAG, "showNativeSendPanelFromBubble")
            pendingScreen = "nativeSendHelper"
            NativeSendPanel.getInstance(reactApplicationContext, this@FloatingToolbarModule).show(fromBubble = true)
            handler.postDelayed({
                callShowPluginView()
                val retryDelays = longArrayOf(50, 250, 750, 1500, 2500)
                for (delay in retryDelays) {
                    handler.postDelayed({
                        if (pendingScreen == "nativeSendHelper") {
                            emitEvent("onToolbarOpenMain", Arguments.createMap())
                        }
                    }, delay)
                }
            }, 150)
        }
    }

    /**
     * 从文本气泡触发 screenshot_ai：直接起 native lasso 截图面板。
     *   - 不调用 openPanel / openPluginView，彻底绕开 RN + React 渲染链路
     *   - 面板内部 screencap + 手绘 + 广播通知中转站
     *   - 关闭时 emit onNativePanelClose，JS 恢复气泡
     */
    @ReactMethod
    fun showNativeLassoScreenshotPanelFromBubble() {
        handler.post {
            Log.i(TAG, "showNativeLassoScreenshotPanelFromBubble")
            removeAll()  // no-op：气泡模式下工具栏本就隐藏；兜底防止遗留
            NativeLassoScreenshotPanel.getInstance(reactApplicationContext, this@FloatingToolbarModule)
                .captureAndShow(fromBubble = true)
        }
    }

    /** Expose callShowPluginView for native panels — 激活 e-ink 层管理 */
    fun showPluginView() {
        handler.post { callShowPluginView() }
    }

    /** Expose callClosePluginView for native panels — 恢复 e-ink 笔迹层 */
    fun closePluginView() {
        handler.post { callClosePluginView() }
    }

    fun emitEventPublic(name: String, params: WritableMap) = emitEvent(name, params)

    // ════════════════════════════════════════════
    //  销毁所有悬浮窗 + 关闭插件
    // ════════════════════════════════════════════

    /** 长按收纳条 / 切出笔记应用时调用：彻底清理所有悬浮窗和插件状态 */
    fun destroyAll() {
        handler.post {
            Log.i(TAG, "destroyAll: removing all overlays + closing plugin")
            // 1. 移除工具栏
            removeAll()
            // 1b. 清理截图遮罩（若仍存活）
            captureToastView?.let {
                try {
                    val wm = reactApplicationContext.getSystemService(android.content.Context.WINDOW_SERVICE) as WindowManager
                    wm.removeView(it)
                } catch (_: Exception) {}
                captureToastView = null
            }
            // 2. 关闭 native 面板
            NativeImagePanel.currentInstance?.hide()
            NativeSendPanel.currentInstance?.hide()
            NativeLassoScreenshotPanel.currentInstance?.hide()
            // 3. 隐藏气泡
            try {
                val bubbleModule = reactApplicationContext.catalystInstance
                    .getNativeModule("FloatingBubble")
                bubbleModule?.let {
                    val hideMethod = it::class.java.methods.firstOrNull { m -> m.name == "hide" && m.parameterCount == 0 }
                    hideMethod?.invoke(it)
                }
            } catch (_: Exception) {}
            // 4. 关闭 plugin view
            callClosePluginView()
            // 5. 停止前台检测
            stopForegroundMonitor()
            Log.i(TAG, "destroyAll: done")
        }
    }

    @ReactMethod
    fun destroyAllFromJs() {
        destroyAll()
    }

    // ════════════════════════════════════════════
    //  前台应用检测 — 只在 com.ratta.supernote.note 中显示
    // ════════════════════════════════════════════

    private val monitorRunnable = object : Runnable {
        override fun run() {
            if (!foregroundMonitorRunning) return
            val inNote = checkIsNoteAppForeground()
            if (inNote != isInNoteApp) {
                isInNoteApp = inNote
                if (!inNote) {
                    // 切出笔记应用 → 隐藏所有悬浮窗
                    Log.i(TAG, "foreground monitor: left note app, hiding overlays")
                    wasVisibleBeforeBackground = rootView != null
                    handler.post {
                        removeAll()
                        NativeImagePanel.currentInstance?.hide()
                        NativeSendPanel.currentInstance?.hide()
                        NativeLassoScreenshotPanel.currentInstance?.hide()
                    }
                } else {
                    // 回到笔记应用 → 恢复悬浮窗
                    Log.i(TAG, "foreground monitor: returned to note app")
                    if (wasVisibleBeforeBackground && tools.isNotEmpty()) {
                        handler.post {
                            if (rootView == null) {
                                collapsed = false
                                createExpandedToolbar()
                            }
                        }
                    }
                }
            }
            handler.postDelayed(this, MONITOR_INTERVAL_MS)
        }
    }

    /** 启动前台应用监控（在 show 时自动调用） */
    fun startForegroundMonitor() {
        if (foregroundMonitorRunning) return
        foregroundMonitorRunning = true
        isInNoteApp = true
        handler.postDelayed(monitorRunnable, MONITOR_INTERVAL_MS)
        Log.i(TAG, "foreground monitor started")
    }

    fun stopForegroundMonitor() {
        foregroundMonitorRunning = false
        handler.removeCallbacks(monitorRunnable)
    }

    @Suppress("DEPRECATION")
    private fun checkIsNoteAppForeground(): Boolean {
        return try {
            val am = reactApplicationContext.getSystemService(
                android.content.Context.ACTIVITY_SERVICE
            ) as android.app.ActivityManager
            val tasks = am.getRunningTasks(1)
            if (tasks.isNotEmpty()) {
                val top = tasks[0].topActivity?.packageName
                top == NOTE_PACKAGE
            } else true // 无法判断时默认显示
        } catch (e: Exception) {
            Log.w(TAG, "checkIsNoteAppForeground: ${e.message}")
            true // 出错时默认显示
        }
    }

    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}