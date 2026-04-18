package com.supernote_quicktoolbar

import android.graphics.Bitmap
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
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.facebook.react.bridge.ReactApplicationContext
import kotlin.concurrent.thread
import kotlin.math.roundToInt

/**
 * NativeSendPanel — 原生 LocalSend 发送面板（WindowManager overlay）
 *
 * 从 React 迁移过来的 Send 屏幕，UI 风格与 React 版本一致。
 * 接收套索提取的文本/图片路径，扫描 LAN 设备，发送给选中设备。
 */
class NativeSendPanel(
    private val reactContext: ReactApplicationContext,
    private val toolbarModule: FloatingToolbarModule
) {
    companion object {
        private const val TAG = "NativeSendPanel"
        @Volatile var currentInstance: NativeSendPanel? = null

        fun getInstance(ctx: ReactApplicationContext, module: FloatingToolbarModule): NativeSendPanel {
            val inst = currentInstance ?: NativeSendPanel(ctx, module)
            currentInstance = inst
            return inst
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var windowManager: WindowManager? = null
    private var rootView: View? = null

    // State
    private var pendingText: String = ""
    private var pendingImages: List<String> = emptyList()
    private var selectedPeer: LocalSendModule.DiscoveredPeer? = null
    private var sending = false
    private var peerPollRunnable: Runnable? = null

    /** 入口上下文：true = 从文本气泡 action 触发，关闭后需 emit 事件让 JS 恢复气泡。 */
    private var cameFromBubble = false

    // UI refs
    private var statusTextView: TextView? = null
    private var previewTextView: TextView? = null
    private var peerContainer: LinearLayout? = null
    private var sendTextBtn: TextView? = null
    private var cancelBtn: View? = null
    private var fileButtonsContainer: LinearLayout? = null

    // ─── Dimensions (matching React) ───
    private val density get() = reactContext.resources.displayMetrics.density
    private val screenW get() = reactContext.resources.displayMetrics.widthPixels
    private val screenH get() = reactContext.resources.displayMetrics.heightPixels
    private val winW get() = (screenW * 0.65).toInt()
    private val winH get() = (screenH * 0.72).toInt()

    private fun dp(v: Int) = (v * density).roundToInt()
    private fun dp(v: Float) = (v * density).roundToInt()

    fun show(fromBubble: Boolean = false) {
        handler.post {
            if (rootView != null) return@post
            pendingText = ""
            pendingImages = emptyList()
            selectedPeer = null
            sending = false
            cameFromBubble = fromBubble
            // 纯 overlay 面板，不调用 showPluginView。
            // 套索提取需要的 plugin view 由 FloatingToolbarModule 的 lasso_send 流程单独管理。
            createPanel()
            startPeerPolling()
            LocalSendModule.triggerScan()
        }
    }

    fun hide() {
        handler.post {
            stopPeerPolling()
            try { windowManager?.removeView(rootView) } catch (_: Exception) {}
            rootView = null; windowManager = null
            statusTextView = null; previewTextView = null; peerContainer = null
            sendTextBtn = null; cancelBtn = null; fileButtonsContainer = null
            currentInstance = null
        }
    }

    /** Called from FloatingToolbarModule.setLassoData after JS extracts lasso content */
    fun updateLassoData(text: String, imagePaths: List<String>) {
        handler.post {
            pendingText = text
            pendingImages = imagePaths
            val statusStr = if (text.isNotEmpty() || imagePaths.isNotEmpty()) {
                "${text.length} chars + ${imagePaths.size} img"
            } else {
                NativeLocale.t("peers_scanning")
            }
            statusTextView?.text = statusStr
            if (text.isNotEmpty()) {
                previewTextView?.text = text.take(200) + if (text.length > 200) "..." else ""
                previewTextView?.visibility = View.VISIBLE
            }
            rebuildFileButtons()
            updateSendBtnState()
        }
    }

    // ════════════════════════════════════════════
    //  Build UI
    // ════════════════════════════════════════════

    private fun createPanel() {
        val ctx = reactContext
        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(ctx)) return

        windowManager = ctx.getSystemService(android.content.Context.WINDOW_SERVICE) as WindowManager

        // ── Root container ──
        val root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                setStroke(dp(1), Color.BLACK)
                cornerRadius = dp(8).toFloat()
            }
            clipToOutline = true
            outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(v: View, o: android.graphics.Outline) {
                    o.setRoundRect(0, 0, v.width, v.height, dp(8).toFloat())
                }
            }
        }

        // ── Title bar ──
        root.addView(createTitleBar())

        // ── Status bar ──
        val statusBar = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(12), dp(16), dp(12))
            addView(View(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0)
            }) // placeholder replaced below
        }
        statusTextView = TextView(ctx).apply {
            text = NativeLocale.t("extracting")
            textSize = 13f; setTextColor(Color.parseColor("#666666"))
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        }
        previewTextView = TextView(ctx).apply {
            textSize = 12f; setTextColor(Color.parseColor("#999999"))
            maxLines = 3; visibility = View.GONE
            setPadding(0, dp(6), 0, 0)
            setLineSpacing(dp(2).toFloat(), 1f)
        }
        statusBar.removeAllViews()
        statusBar.addView(statusTextView)
        statusBar.addView(previewTextView)
        // divider
        statusBar.addView(View(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(1)
            ).apply { topMargin = dp(12) }
            setBackgroundColor(Color.parseColor("#D8D8D8"))
        })
        root.addView(statusBar)

        // ── Peer list (scrollable) ──
        val scrollView = ScrollView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f
            )
        }
        peerContainer = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
        }
        scrollView.addView(peerContainer)
        root.addView(scrollView)
        refreshPeerList()

        // ── Bottom bar ──
        root.addView(createBottomBar())

        // ── Window params ──
        val wmType = if (Build.VERSION.SDK_INT >= 26)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE

        val lp = WindowManager.LayoutParams(
            winW, winH, wmType,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.CENTER
        }

        rootView = root
        windowManager?.addView(root, lp)
        Log.i(TAG, "send panel shown")
    }

    private fun createTitleBar(): LinearLayout {
        val ctx = reactContext
        val bar = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(16))
        }
        // Title
        bar.addView(TextView(ctx).apply {
            text = NativeLocale.t("send_title")
            textSize = 20f; setTextColor(Color.BLACK)
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        })
        // Close button
        bar.addView(makeMinBtn("X") {
            closeAndRestore()
        })
        // Divider
        val wrapper = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        wrapper.addView(bar)
        wrapper.addView(makeDivider())
        return wrapper
    }

    private fun createBottomBar(): LinearLayout {
        val ctx = reactContext
        val wrapper = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        wrapper.addView(makeDivider())

        val bar = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(12), dp(16), dp(12))
        }

        // Cancel
        cancelBtn = makeOutlinedBtn(NativeLocale.t("cancel")) { closeAndRestore() }
        bar.addView(cancelBtn)

        // Spacer
        bar.addView(View(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(0, 1, 1f)
        })

        // File buttons container (dynamically populated)
        fileButtonsContainer = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        bar.addView(fileButtonsContainer)

        // Send text button
        sendTextBtn = makeFilledBtn(NativeLocale.t("send_text_btn")) {
            handleSendText()
        }
        updateSendBtnState()
        bar.addView(sendTextBtn)

        wrapper.addView(bar)
        return wrapper
    }

    // ════════════════════════════════════════════
    //  Peer list
    // ════════════════════════════════════════════

    private fun refreshPeerList() {
        handler.post {
            val container = peerContainer ?: return@post
            container.removeAllViews()
            val peers = LocalSendModule.getPeersSnapshot()

            if (peers.isEmpty()) {
                container.addView(makeEmptyView(
                    NativeLocale.t("peers_scanning"),
                    NativeLocale.t("peers_none")
                ))
                return@post
            }

            for (peer in peers) {
                container.addView(createPeerRow(peer))
            }
        }
    }

    private fun createPeerRow(peer: LocalSendModule.DiscoveredPeer): LinearLayout {
        val ctx = reactContext
        val isSelected = selectedPeer?.fingerprint == peer.fingerprint
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(14), dp(16), dp(14))
            setBackgroundColor(if (isSelected) Color.parseColor("#F5F5F5") else Color.WHITE)
            setOnClickListener {
                selectedPeer = peer
                refreshPeerList()
                updateSendBtnState()
            }
        }

        val info = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        info.addView(TextView(ctx).apply {
            text = peer.alias; textSize = 15f; setTextColor(Color.BLACK)
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        })
        info.addView(TextView(ctx).apply {
            text = "${peer.ip}:${peer.port} · ${peer.deviceType}"
            textSize = 12f; setTextColor(Color.parseColor("#999999"))
            setPadding(0, dp(2), 0, 0)
        })
        row.addView(info)

        if (isSelected) {
            row.addView(TextView(ctx).apply {
                text = "✓"; textSize = 16f; setTextColor(Color.BLACK)
                typeface = Typeface.DEFAULT_BOLD
                setPadding(dp(12), 0, 0, 0)
            })
        }

        // Row divider
        val wrapper = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            addView(row)
            addView(View(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, dp(1)
                )
                setBackgroundColor(Color.parseColor("#F0F0F0"))
            })
        }
        return wrapper
    }

    // ════════════════════════════════════════════
    //  Send actions
    // ════════════════════════════════════════════

    private fun handleSendText() {
        val peer = selectedPeer ?: return
        if (pendingText.isEmpty() || sending) return
        sending = true
        statusTextView?.text = NativeLocale.t("sending")
        updateSendBtnState()
        thread(isDaemon = true) {
            try {
                LocalSendModule.sendTextDirect(peer.ip, peer.port, pendingText)
                handler.post {
                    statusTextView?.text = NativeLocale.t("send_success")
                    handler.postDelayed({ closeAndRestore() }, 800)
                }
            } catch (e: Exception) {
                handler.post {
                    sending = false
                    statusTextView?.text = "${NativeLocale.t("send_failed")}: ${e.message}"
                    updateSendBtnState()
                }
            }
        }
    }

    private fun handleSendFile(path: String) {
        val peer = selectedPeer ?: return
        if (sending) return
        sending = true
        statusTextView?.text = NativeLocale.t("sending")
        updateSendBtnState()
        thread(isDaemon = true) {
            try {
                LocalSendModule.sendFileDirect(peer.ip, peer.port, path)
                handler.post {
                    statusTextView?.text = NativeLocale.t("send_success")
                    handler.postDelayed({ closeAndRestore() }, 800)
                }
            } catch (e: Exception) {
                handler.post {
                    sending = false
                    statusTextView?.text = "${NativeLocale.t("send_failed")}: ${e.message}"
                    updateSendBtnState()
                }
            }
        }
    }

    // ════════════════════════════════════════════
    //  Peer polling
    // ════════════════════════════════════════════

    private fun startPeerPolling() {
        stopPeerPolling()
        peerPollRunnable = object : Runnable {
            override fun run() {
                refreshPeerList()
                handler.postDelayed(this, 3000)
            }
        }
        handler.post(peerPollRunnable!!)
    }

    private fun stopPeerPolling() {
        peerPollRunnable?.let { handler.removeCallbacks(it) }
        peerPollRunnable = null
    }

    // ════════════════════════════════════════════
    //  Helpers
    // ════════════════════════════════════════════

    private fun closeAndRestore() {
        val fromBubble = cameFromBubble
        hide()
        toolbarModule.requestClosePluginView()
        if (fromBubble) {
            // 直接从 Kotlin 恢复气泡，不依赖 JS round-trip。
            // closePluginView 可能销毁 CatalystInstance，JS setTimeout 永远不会执行。
            handler.postDelayed({
                FloatingBubbleModule.reshowLast(reactContext)
            }, 350)
        } else {
            // 工具栏入口：恢复工具栏（原行为）
            toolbarModule.restoreToolbar()
        }
    }

    private fun updateSendBtnState() {
        val enabled = selectedPeer != null && pendingText.isNotEmpty() && !sending
        sendTextBtn?.apply {
            alpha = if (enabled) 1f else 0.4f
            isEnabled = enabled
        }
    }

    private fun rebuildFileButtons() {
        val container = fileButtonsContainer ?: return
        container.removeAllViews()
        for ((idx, path) in pendingImages.withIndex()) {
            val btn = makeOutlinedBtn("${NativeLocale.t("send_files_btn")} ${idx + 1}") {
                handleSendFile(path)
            }
            (btn.layoutParams as? LinearLayout.LayoutParams)?.rightMargin = dp(10)
            container.addView(btn)
        }
    }

    // ── Styled widget factories (match React styles) ──

    private fun makeMinBtn(label: String, onClick: () -> Unit): TextView {
        return TextView(reactContext).apply {
            text = label; textSize = 14f
            setTextColor(Color.parseColor("#333333"))
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            gravity = Gravity.CENTER
            setPadding(dp(12), dp(6), dp(12), dp(6))
            background = GradientDrawable().apply {
                setColor(Color.WHITE); setStroke(dp(1), Color.parseColor("#999999"))
                cornerRadius = dp(4).toFloat()
            }
            setOnClickListener { onClick() }
        }
    }

    private fun makeOutlinedBtn(label: String, onClick: () -> Unit): TextView {
        return TextView(reactContext).apply {
            text = label; textSize = 15f; setTextColor(Color.BLACK)
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            gravity = Gravity.CENTER
            setPadding(dp(28), dp(10), dp(28), dp(10))
            background = GradientDrawable().apply {
                setColor(Color.WHITE); setStroke(dp(1), Color.BLACK)
            }
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            setOnClickListener { onClick() }
        }
    }

    private fun makeFilledBtn(label: String, onClick: () -> Unit): TextView {
        return TextView(reactContext).apply {
            text = label; textSize = 15f; setTextColor(Color.WHITE)
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            gravity = Gravity.CENTER
            setPadding(dp(28), dp(10), dp(28), dp(10))
            setBackgroundColor(Color.BLACK)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { leftMargin = dp(12) }
            setOnClickListener { onClick() }
        }
    }

    private fun makeDivider(): View {
        return View(reactContext).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(1)
            )
            setBackgroundColor(Color.parseColor("#D8D8D8"))
        }
    }

    private fun makeEmptyView(title: String, hint: String): LinearLayout {
        return LinearLayout(reactContext).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(20), dp(60), dp(20), 0)
            addView(TextView(reactContext).apply {
                text = title; textSize = 15f
                setTextColor(Color.parseColor("#999999"))
                typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                gravity = Gravity.CENTER
            })
            addView(TextView(reactContext).apply {
                text = hint; textSize = 12f
                setTextColor(Color.parseColor("#BBBBBB"))
                gravity = Gravity.CENTER
                setPadding(dp(20), dp(8), dp(20), 0)
            })
        }
    }
}
