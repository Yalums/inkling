package com.supernote_quicktoolbar

import android.content.Intent
import android.graphics.*
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.*
import android.widget.*
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import kotlin.concurrent.thread
import kotlin.math.roundToInt

/**
 * NativeLassoScreenshotPanel — 全屏截图 + 自由手绘套索面板（WindowManager overlay）
 *
 * 完整替代 ScreenshotLassoOverlay.tsx：
 *   - 截屏（内部调用 screencap，不依赖 JS ScreenshotModule 流程）
 *   - 自由手绘圈选
 *   - 反向遮罩（圈外暗化，圈内清晰）
 *   - Cancel / Clear / Confirm 按钮
 *   - Confirm → 将截图和 mask JSON 落盘到 /sdcard/SCREENSHOT/.plugin_staging/lasso_ai/，
 *     然后通过 Intent com.dictation.IMAGE_QUERY_FROM_PLUGIN 通知中转站
 *
 * 关键设计：
 *   - 不调用 showPluginView（避免 PluginManager 状态被破坏）
 *   - 不依赖 RN 组件渲染，纯 Kotlin Canvas
 *   - 关闭后 emit onNativePanelClose 事件，由 JS BackgroundService 恢复气泡
 */
class NativeLassoScreenshotPanel(
    private val reactContext: ReactApplicationContext,
    private val toolbarModule: FloatingToolbarModule
) {
    companion object {
        private const val TAG = "NativeLassoScreenshotPanel"
        @Volatile var currentInstance: NativeLassoScreenshotPanel? = null

        fun getInstance(ctx: ReactApplicationContext, module: FloatingToolbarModule): NativeLassoScreenshotPanel {
            val inst = currentInstance ?: NativeLassoScreenshotPanel(ctx, module)
            currentInstance = inst
            return inst
        }

        private const val STAGE_DIR = "/sdcard/SCREENSHOT/.plugin_staging/lasso_ai"
    }

    private val handler = Handler(Looper.getMainLooper())
    private var windowManager: WindowManager? = null
    private var rootView: FrameLayout? = null

    private var screenshotPath: String? = null
    private var bitmap: Bitmap? = null
    private var bitmapWidth = 0
    private var bitmapHeight = 0

    private var drawView: LassoDrawView? = null
    private var clearBtn: TextView? = null
    private var confirmBtn: TextView? = null

    /** entry 上下文：从气泡触发 = true，影响关闭后的恢复策略 */
    private var cameFromBubble = false

    private val density get() = reactContext.resources.displayMetrics.density
    private val screenW get() = reactContext.resources.displayMetrics.widthPixels
    private val screenH get() = reactContext.resources.displayMetrics.heightPixels
    private fun dp(v: Int) = (v * density).roundToInt()
    private fun dp(v: Float) = (v * density).roundToInt()

    /**
     * 入口：截屏 → 显示面板。
     * @param fromBubble true 表示从文本气泡 action 触发，关闭后需恢复气泡；
     *                   false 表示从工具栏触发（目前未使用，预留）。
     */
    fun captureAndShow(fromBubble: Boolean) {
        cameFromBubble = fromBubble
        // 截屏在 worker 线程跑，避免阻塞 UI
        thread(isDaemon = false) {
            val path = runScreencap() ?: run {
                Log.e(TAG, "screencap failed")
                handler.post { emitCloseEvent() }
                return@thread
            }
            // 回到主线程加载图片和起面板
            handler.post {
                val bmp = BitmapFactory.decodeFile(path)
                if (bmp == null) {
                    Log.e(TAG, "bitmap decode failed for $path")
                    emitCloseEvent()
                    return@post
                }
                screenshotPath = path
                bitmap = bmp
                bitmapWidth = bmp.width
                bitmapHeight = bmp.height
                createPanel()
            }
        }
    }

    private fun runScreencap(): String? {
        return try {
            val ts = System.currentTimeMillis()
            val outPath = "${reactContext.cacheDir.absolutePath}/lasso_screenshot_$ts.png"
            Log.i(TAG, "screencap -> $outPath")
            val proc = Runtime.getRuntime().exec(arrayOf("screencap", "-p", outPath))
            val exit = proc.waitFor()
            val f = File(outPath)
            Log.i(TAG, "screencap exit=$exit size=${f.length()}")
            if (exit == 0 && f.exists() && f.length() > 500) outPath else null
        } catch (e: Exception) {
            Log.e(TAG, "screencap EX: ${e.message}", e)
            null
        }
    }

    fun hide() {
        handler.post {
            try { windowManager?.removeView(rootView) } catch (_: Exception) {}
            rootView = null; windowManager = null
            drawView = null; clearBtn = null; confirmBtn = null
            bitmap?.recycle(); bitmap = null
            currentInstance = null
        }
    }

    // ════════════════════════════════════════════
    //  Build UI
    // ════════════════════════════════════════════

    private fun createPanel() {
        val ctx = reactContext
        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(ctx)) {
            Log.e(TAG, "no overlay permission")
            emitCloseEvent()
            return
        }

        windowManager = ctx.getSystemService(android.content.Context.WINDOW_SERVICE) as WindowManager

        // 1. 计算图片在屏幕上的展示矩形（保持宽高比）
        val imgAspect = bitmapWidth.toFloat() / bitmapHeight
        val screenAspect = screenW.toFloat() / screenH
        val dispW: Float; val dispH: Float; val offX: Float; val offY: Float
        if (imgAspect > screenAspect) {
            dispW = screenW.toFloat()
            dispH = screenW / imgAspect
            offX = 0f
            offY = (screenH - dispH) / 2f
        } else {
            dispH = screenH.toFloat()
            dispW = screenH * imgAspect
            offX = (screenW - dispW) / 2f
            offY = 0f
        }
        val imgRect = RectF(offX, offY, offX + dispW, offY + dispH)

        // 2. 根 FrameLayout（黑底）
        val root = FrameLayout(ctx).apply {
            setBackgroundColor(Color.BLACK)
        }

        // 3. 底层：ImageView 显示截图
        val iv = ImageView(ctx).apply {
            setImageBitmap(bitmap)
            scaleType = ImageView.ScaleType.FIT_CENTER
        }
        root.addView(iv, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ))

        // 4. 中层：自定义绘制 View（暗化遮罩 + lasso 路径 + 触摸）
        drawView = LassoDrawView(ctx, imgRect) {
            updateButtonStates()
        }
        root.addView(drawView, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ))

        // 5. 顶层：底部按钮条（在 78% Y 处）
        val ctrlY = (screenH * 0.78f).roundToInt()
        val ctrlBar = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }
        val cancelBtn = makeOutlinedBtn(NativeLocale.t("cancel")) { onCancel() }
        clearBtn = makeOutlinedBtn(NativeLocale.t("lasso_clear")) { onClear() }
        confirmBtn = makeFilledBtn(NativeLocale.t("confirm")) { onConfirm() }

        ctrlBar.addView(cancelBtn, LinearLayout.LayoutParams(dp(130), dp(46)).apply { marginEnd = dp(12) })
        ctrlBar.addView(clearBtn, LinearLayout.LayoutParams(dp(130), dp(46)).apply { marginEnd = dp(12) })
        ctrlBar.addView(confirmBtn, LinearLayout.LayoutParams(dp(130), dp(46)))

        val ctrlLp = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.WRAP_CONTENT
        ).apply {
            topMargin = ctrlY
            gravity = Gravity.TOP
        }
        root.addView(ctrlBar, ctrlLp)

        // 6. 提示文字（无点时显示在上部）
        val hint = TextView(ctx).apply {
            text = NativeLocale.t("lasso_hint")
            setTextColor(Color.WHITE)
            textSize = 14f
            setBackgroundColor(Color.argb(180, 0, 0, 0))
            setPadding(dp(14), dp(6), dp(14), dp(6))
            gravity = Gravity.CENTER
        }
        val hintLp = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            FrameLayout.LayoutParams.WRAP_CONTENT
        ).apply {
            topMargin = (screenH * 0.08f).roundToInt()
            gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
        }
        root.addView(hint, hintLp)
        drawView?.hintView = hint

        // 7. Window params — TYPE_APPLICATION_OVERLAY 全屏可聚焦
        val wmType = if (Build.VERSION.SDK_INT >= 26)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE

        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            wmType,
            // 需要接收触摸事件才能画 lasso；不 FOCUSABLE 避免键盘等副作用
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply { gravity = Gravity.TOP or Gravity.START }

        rootView = root
        try {
            windowManager?.addView(root, lp)
            Log.i(TAG, "panel shown, img=${bitmapWidth}x$bitmapHeight screen=${screenW}x$screenH")
            updateButtonStates()
        } catch (e: Exception) {
            Log.e(TAG, "addView failed: ${e.message}", e)
            windowManager = null
            rootView = null
            emitCloseEvent()
        }
    }

    private fun updateButtonStates() {
        val dv = drawView ?: return
        val hasAny = dv.pointCount() > 0
        val hasValid = dv.hasValidLasso()
        clearBtn?.visibility = if (hasAny) View.VISIBLE else View.INVISIBLE
        confirmBtn?.apply {
            alpha = if (hasValid) 1f else 0.35f
            isEnabled = hasValid
        }
    }

    // ════════════════════════════════════════════
    //  Button actions
    // ════════════════════════════════════════════

    private fun onCancel() {
        Log.i(TAG, "cancel")
        hide()
        emitCloseEvent()
    }

    private fun onClear() {
        drawView?.clearPoints()
    }

    private fun onConfirm() {
        val dv = drawView ?: return
        val srcPath = screenshotPath ?: return
        if (!dv.hasValidLasso()) return
        val screenPoints = dv.getPoints()

        // 屏幕坐标 → 图片坐标（原始像素）
        val imgRect = dv.imgRect
        val scaleX = bitmapWidth.toFloat() / imgRect.width()
        val scaleY = bitmapHeight.toFloat() / imgRect.height()
        val imgPoints = screenPoints.map {
            PointF(
                ((it.x - imgRect.left) * scaleX),
                ((it.y - imgRect.top) * scaleY)
            )
        }

        // 关闭面板（文件写入在后台线程做，不阻塞 UI）
        hide()
        thread(isDaemon = false) {
            val ok = stageAndBroadcast(srcPath, imgPoints)
            Log.i(TAG, "confirm stage+broadcast ok=$ok")
            handler.post { emitCloseEvent() }
        }
    }

    /**
     * 把原图拷贝到 staging 目录 + 写 mask JSON + 发广播给中转站。
     * 返回是否成功。
     */
    private fun stageAndBroadcast(srcPath: String, imgPoints: List<PointF>): Boolean {
        return try {
            val dir = File(STAGE_DIR)
            if (!dir.exists()) dir.mkdirs()

            val ts = System.currentTimeMillis()
            val destImg = "$STAGE_DIR/$ts.png"
            val destMask = "$STAGE_DIR/$ts.mask.json"

            // 1. 拷贝截图
            File(srcPath).copyTo(File(destImg), overwrite = true)

            // 2. 计算 bounding box + 写 mask JSON（和 ScreenshotLassoOverlay 的格式对齐）
            var minX = imgPoints[0].x; var maxX = minX
            var minY = imgPoints[0].y; var maxY = minY
            for (p in imgPoints) {
                if (p.x < minX) minX = p.x
                if (p.x > maxX) maxX = p.x
                if (p.y < minY) minY = p.y
                if (p.y > maxY) maxY = p.y
            }

            val polyArr = JSONArray()
            for (p in imgPoints) {
                polyArr.put(JSONObject().apply {
                    put("x", p.x.roundToInt())
                    put("y", p.y.roundToInt())
                })
            }
            val boxObj = JSONObject().apply {
                put("x", minX.roundToInt()); put("y", minY.roundToInt())
                put("w", (maxX - minX).roundToInt()); put("h", (maxY - minY).roundToInt())
            }
            val mask = JSONObject().apply {
                put("imageWidth", bitmapWidth)
                put("imageHeight", bitmapHeight)
                put("boundingBox", boxObj)
                put("polygon", polyArr)
                put("ts", ts)
            }
            FileOutputStream(destMask).use { it.write(mask.toString().toByteArray(Charsets.UTF_8)) }

            // 3. 广播给中转站 —— 和 BroadcastBridgeModule.sendImageQuery 等价
            val intent = Intent("com.dictation.IMAGE_QUERY_FROM_PLUGIN").apply {
                putExtra("imagePath", destImg)
                putExtra("maskPath", destMask)
                putExtra("prompt", "")
            }
            reactContext.sendBroadcast(intent)
            Log.i(TAG, "broadcast sent: img=$destImg mask=$destMask")
            true
        } catch (e: Exception) {
            Log.e(TAG, "stageAndBroadcast failed: ${e.message}", e)
            false
        }
    }

    /** 通知 JS 面板已关闭 + 从 Kotlin 直接恢复气泡 */
    private fun emitCloseEvent() {
        // 尝试通知 JS（兜底，CatalystInstance 存活时有效）
        try {
            val params = Arguments.createMap().apply {
                putString("panel", "lassoScreenshot")
                putBoolean("cameFromBubble", cameFromBubble)
            }
            toolbarModule.emitEventPublic("onNativePanelClose", params)
        } catch (_: Exception) {}
        // 主路径：直接从 Kotlin 恢复气泡，不依赖 JS round-trip
        if (cameFromBubble) {
            handler.postDelayed({
                FloatingBubbleModule.reshowLast(reactContext)
            }, 350)
        }
    }

    // ════════════════════════════════════════════
    //  UI helpers
    // ════════════════════════════════════════════

    private fun makeOutlinedBtn(label: String, onClick: () -> Unit): TextView {
        return TextView(reactContext).apply {
            text = label
            textSize = 15f
            setTextColor(Color.BLACK)
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                setStroke(dp(1), Color.BLACK)
                cornerRadius = dp(4).toFloat()
            }
            setOnClickListener { onClick() }
        }
    }

    private fun makeFilledBtn(label: String, onClick: () -> Unit): TextView {
        return TextView(reactContext).apply {
            text = label
            textSize = 15f
            setTextColor(Color.WHITE)
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                setColor(Color.BLACK)
                cornerRadius = dp(4).toFloat()
            }
            setOnClickListener { onClick() }
        }
    }
}

// ════════════════════════════════════════════
//  LassoDrawView — 自由手绘 + 反向遮罩 + 触摸捕获
// ════════════════════════════════════════════

/**
 * 自定义 View：
 *   - 触摸时累积路径点（MIN_POINT_DIST 间隔过滤）
 *   - onDraw: 暗化整屏 → 用 PorterDuff.Mode.CLEAR 挖空封闭多边形内部
 *   - 绘制白色路径线 + 起点标记
 *   - 提供 getPoints() / clearPoints() / hasValidLasso()
 */
class LassoDrawView(
    context: android.content.Context,
    val imgRect: RectF,
    private val onChanged: () -> Unit
) : View(context) {

    companion object {
        private const val MIN_POINT_DIST_PX = 8f
        private const val LINE_WIDTH_PX = 3f
    }

    private val points = mutableListOf<PointF>()
    private var drawing = false

    var hintView: View? = null

    private val pathPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        style = Paint.Style.STROKE
        strokeWidth = LINE_WIDTH_PX
        strokeJoin = Paint.Join.ROUND
        strokeCap = Paint.Cap.ROUND
    }
    private val dimPaint = Paint().apply {
        color = Color.argb(140, 0, 0, 0)  // 约 55% 黑
    }
    private val cutPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        xfermode = android.graphics.PorterDuffXfermode(PorterDuff.Mode.CLEAR)
    }
    private val startDotFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
    private val startDotStroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.BLACK
        style = Paint.Style.STROKE
        strokeWidth = 2f
    }

    init {
        // 启用软件层，确保 PorterDuff CLEAR 按预期工作
        setLayerType(LAYER_TYPE_SOFTWARE, null)
    }

    fun pointCount(): Int = points.size
    fun hasValidLasso(): Boolean = points.size >= 3
    fun getPoints(): List<PointF> = points.toList()

    fun clearPoints() {
        points.clear()
        drawing = false
        hintView?.visibility = View.VISIBLE
        invalidate()
        onChanged()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        // 限定在图片展示区内
        val x = event.x.coerceIn(imgRect.left, imgRect.right)
        val y = event.y.coerceIn(imgRect.top, imgRect.bottom)
        when (event.action) {
            MotionEvent.ACTION_DOWN -> {
                points.clear()
                points.add(PointF(x, y))
                drawing = true
                hintView?.visibility = View.GONE
                invalidate()
                onChanged()
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                val last = points.lastOrNull() ?: return true
                val dx = x - last.x; val dy = y - last.y
                if (dx * dx + dy * dy < MIN_POINT_DIST_PX * MIN_POINT_DIST_PX) return true
                points.add(PointF(x, y))
                invalidate()
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                drawing = false
                invalidate()
                onChanged()
                return true
            }
        }
        return super.onTouchEvent(event)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat(); val h = height.toFloat()
        if (w <= 0 || h <= 0) return

        // 暗化遮罩 + 封闭多边形挖空
        if (!drawing && points.size >= 3) {
            val sc = canvas.saveLayer(0f, 0f, w, h, null)
            canvas.drawRect(0f, 0f, w, h, dimPaint)
            val cutPath = Path().apply {
                moveTo(points[0].x, points[0].y)
                for (i in 1 until points.size) lineTo(points[i].x, points[i].y)
                close()
            }
            canvas.drawPath(cutPath, cutPaint)
            canvas.restoreToCount(sc)
        } else {
            // 绘制中或点数不足：整屏均匀暗化
            canvas.drawRect(0f, 0f, w, h, dimPaint)
        }

        // 白色路径线
        if (points.size >= 2) {
            val linePath = Path().apply {
                moveTo(points[0].x, points[0].y)
                for (i in 1 until points.size) lineTo(points[i].x, points[i].y)
                if (!drawing && points.size >= 3) lineTo(points[0].x, points[0].y)
            }
            canvas.drawPath(linePath, pathPaint)
        }

        // 起点标记（白圆 + 黑边）
        if (points.isNotEmpty()) {
            val p = points[0]
            val r = 6f
            canvas.drawCircle(p.x, p.y, r, startDotFill)
            canvas.drawCircle(p.x, p.y, r, startDotStroke)
        }
    }
}
