/**
 * App.tsx — QuickToolbar 主面板（重新设计的 UX）
 *
 * 屏幕：
 *   - main:         QuickToolbar 工具预设管理（含实时预览 + 工具列表）
 *   - add_tool:     工具目录添加（含分类筛选）
 *   - permission:   悬浮窗权限引导
 *   - nativeHelper: 透明占位（供 native panel 使用）
 *
 * NOTE: insertImage / cropper / send 已完全迁移到 native（NativeImagePanel / NativeSendPanel），
 * 对应的 React state、handler、subscription 已全部清理。
 *
 * 关键修复：☰ 收纳按钮 → 主面板不可见
 *   1. 同步读取 pending flag（不清除），避免与异步 .then 竞态
 *   2. AppState 'active' 时复活 BackgroundService + 强制再次 setScreen('main')
 *   3. native 端 ackOpenMain() 后才清除 pending flag
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, StyleSheet, Pressable, Text, StatusBar, Dimensions,
  ScrollView, DeviceEventEmitter, AppState, AppStateStatus, NativeModules,
} from 'react-native';
import { PluginManager, PluginNoteAPI } from 'sn-plugin-lib';

import FloatingToolbarBridge, { ToolItem } from './components/FloatingToolbarBridge';
import FloatingBubbleBridge from './components/FloatingBubbleBridge';
import {
  AVAILABLE_TOOLS, getAvailableTools,
  loadConfig, saveConfig, isValidToolCount,
  loadClips, injectClipStatus, ClipData,
  getLayoutForCount, getToolCategory, ToolCategory,
  getAvailableBubbleActions, loadBubbleActions, saveBubbleActions, BubbleAction,
} from './components/ToolPresets';
import {
  ensureInit, getActiveMode, flushPendingTexts, reviveIfNeeded,
  setInsertTop, toggleMode, pauseInsertion, refreshBubbleActions,
} from './components/BackgroundService';
import { executeAction } from './components/ToolActions';
import { InsertMode } from './components/TextInserter';
import { FileLogger } from './components/FileLogger';
import { LassoExtractor } from './components/LassoExtractor';
import { checkPendingButton, peekPendingButton } from './pendingButton';
import { t } from './components/i18n';

// ── Screenshot / Stitch imports ──
import { CropOverlay, CropResult } from './components/CropOverlay';
import { StitchEditor } from './components/StitchEditor';
import { StitchSession, StitchSessionData } from './components/StitchSession';
import { StagingService } from './components/StagingService';
import { ScreenshotService } from './components/ScreenshotService';
const { ScreenshotModule } = NativeModules;

const screenWidth  = Dimensions.get('window').width;
const screenHeight = Dimensions.get('window').height;
const WINDOW_WIDTH  = screenWidth  * 0.65;
const WINDOW_HEIGHT = screenHeight * 0.72;

type AppScreen = 'main' | 'add_tool' | 'permission' | 'nativeHelper' | 'cropping' | 'stitching';
type CatFilter = 'all' | ToolCategory;

/** 分类筛选列表 */
const CAT_FILTERS: { key: CatFilter; labelKey: string }[] = [
  { key: 'all',    labelKey: 'cat_all' },
  { key: 'layer',  labelKey: 'cat_layer' },
  { key: 'insert', labelKey: 'cat_insert' },
  { key: 'text',   labelKey: 'cat_text' },
  { key: 'lasso',  labelKey: 'cat_lasso' },
  { key: 'clip',   labelKey: 'cat_clip' },
];

/** 布局选项（用于预览区域显示） */
const LAYOUT_OPTIONS = [
  { key: '3x2', cols: 3, rows: 2, count: 5,  label: '3×2' },
  { key: '4x2', cols: 4, rows: 2, count: 7,  label: '4×2' },
  { key: '3x3', cols: 3, rows: 3, count: 8,  label: '3×3' },
  { key: '4x3', cols: 4, rows: 3, count: 11, label: '4×3' },
];

// ════════════════════════════════════════════════
//  迷你工具栏预览组件
// ════════════════════════════════════════════════

function MiniToolbarPreview({ tools, side }: { tools: ToolItem[]; side: 'left' | 'right' }) {
  const layout = getLayoutForCount(tools.length);
  const { cols, rows } = layout;
  const isL = side === 'left';
  const cellSize = 22;
  const gap = 2;
  const pad = 2;
  const maxShow = cols * rows;
  const handleW = 4;
  const gridW = cols * cellSize + (cols - 1) * gap + pad * 2;
  const gridH = rows * cellSize + (rows - 1) * gap + pad * 2;

  const gridView = (
    <View style={{ width: gridW, height: gridH, backgroundColor: '#F0F0F0', borderRadius: 2, padding: pad, gap, flexDirection: 'row', flexWrap: 'wrap' }}>
      {[...Array(maxShow)].map((_, i) => (
        <View key={i} style={{ width: cellSize, height: cellSize, backgroundColor: tools[i] ? '#888' : '#CCCCCC', borderRadius: 2, margin: gap / 2 }} />
      ))}
    </View>
  );
  const handleView = (
    <View style={{ width: handleW, height: gridH, backgroundColor: '#AAAAAA', borderRadius: 1 }} />
  );
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {!isL && gridView}{handleView}{isL && gridView}
    </View>
  );
}

// ════════════════════════════════════════════════
//  主应用
// ════════════════════════════════════════════════

function App(): React.JSX.Element {
  // Peek pending button / screen to set correct initial screen (avoids flashing wrong UI)
  const initialPending = peekPendingButton();
  const initialPendingScreen = FloatingToolbarBridge.getPendingScreenSync();
  console.log('[LASSO-DBG/App] App component init: pendingBtn=', initialPending, 'pendingScreen=', JSON.stringify(initialPendingScreen));
  const [screen, setScreen]               = useState<AppScreen>(
    initialPending === 300 ? 'nativeHelper' : 'main'
  );
  const [tools, setTools]                 = useState<ToolItem[]>(AVAILABLE_TOOLS.slice(0, 8));
  const [clips, setClips]                 = useState<ClipData>({ '1': null, '2': null, '3': null, '4': null, '5': null, '6': null });
  const [statusMsg, setStatusMsg]         = useState('');
  const [hasPermission, setHasPermission] = useState(false);
  const [insertMode, setInsertMode]       = useState<InsertMode | null>(null);
  const [_resumeTick, setResumeTick]      = useState(0);
  const dockSide                          = 'left' as const;
  const [catFilter, setCatFilter]         = useState<CatFilter>('all');
  const [bubbleActionIds, setBubbleActionIds] = useState<string[]>([]);
  const allBubbleActions                      = getAvailableBubbleActions();

  // ── Screenshot / Stitch state ──
  const [screenshotUri, setScreenshotUri]       = useState<string | null>(null);
  const [originalSize, setOriginalSize]         = useState({ width: 0, height: 0 });
  const [hasStitchSession, setHasStitchSession] = useState(false);
  const [stitchSession, setStitchSession]       = useState<StitchSessionData | null>(null);
  const [isCompositing, setIsCompositing]       = useState(false);
  const screenshotBusyRef = useRef(false);

  const toolsRef      = useRef(tools);       toolsRef.current      = tools;
  const clipsRef      = useRef(clips);       clipsRef.current      = clips;
  const insertModeRef = useRef(insertMode);  insertModeRef.current = insertMode;
  const hasPermissionRef = useRef(hasPermission); hasPermissionRef.current = hasPermission;

  const showStatus = (msg: string) => {
    setStatusMsg(msg);
    setTimeout(() => setStatusMsg(''), 2500);
  };

  const refreshToolbar = useCallback(async (c?: ClipData, ts?: ToolItem[], mode?: InsertMode | null) => {
    const data = c   || clipsRef.current;
    const tl   = ts  || toolsRef.current;
    const m    = mode !== undefined ? mode : insertModeRef.current;
    FloatingToolbarBridge.updateTools(injectClipStatus(tl, data, m));
  }, []);

  /**
   * Clear screenshot / crop / stitch / lasso state left over from a previous session.
   *
   * Why: in NOTE, after a flow that uses one of these screens (e.g. DOC-style crop via
   * button 300, or lasso screenshot), plugin view closes but the RN context is NOT
   * torn down — React state survives. On bridge revival (plugin view re-opens), the
   * mount useEffect does NOT re-run, so its own resets (around lines 440 / 496 / 507)
   * don't fire. Any onToolbarOpenMain / handleButton path that lands on 'main' or
   * 'nativeHelper' must call this explicitly, otherwise the next render briefly shows
   * a stale `screen=cropping` / `lassoPath=<old file>` before setScreen settles.
   */
  const resetTransientScreens = useCallback(() => {
    setScreenshotUri(null);
    setOriginalSize({ width: 0, height: 0 });
    setStitchSession(null);
  }, []);

  const layout      = getLayoutForCount(tools.length);
  const layoutLabel = `${layout.cols}×${layout.rows}`;

  // ════════════════════════════════════════════════
  //  DOC Screenshot / Stitch handlers
  // ════════════════════════════════════════════════

  const loadScreenshot = useCallback(async () => {
    console.log('[CROP-DBG/App] loadScreenshot START, busy=', screenshotBusyRef.current);
    if (screenshotBusyRef.current) return;
    screenshotBusyRef.current = true;
    setScreen('cropping');
    setScreenshotUri(null);
    setOriginalSize({ width: 0, height: 0 });
    try {
      const nativePath: string | null = await ScreenshotModule.getPendingPath();
      console.log('[CROP-DBG/App] getPendingPath =', nativePath);
      const dims = await ScreenshotService.getDeviceDimensions();
      console.log('[CROP-DBG/App] device dims =', dims);

      let uri: string;
      if (nativePath) {
        uri = `file://${nativePath}`;
      } else {
        console.log('[CROP-DBG/App] no native path, calling ScreenshotService.capture()');
        uri = await ScreenshotService.capture();
        console.log('[CROP-DBG/App] capture result =', uri);
      }

      // Check for active stitch session
      const activeSession = await StitchSession.load();
      if (activeSession && activeSession.images.length >= 1) {
        const rawPath = nativePath || uri.replace('file://', '');
        const updatedSession = await StitchSession.addImage(rawPath, dims.width, dims.height);
        if (updatedSession && updatedSession.images.length >= 2) {
          console.log('[CROP-DBG/App] entering stitch mode');
          setStitchSession(updatedSession);
          setScreen('stitching');
          screenshotBusyRef.current = false;
          return;
        }
      }

      console.log('[CROP-DBG/App] setting screenshotUri =', uri, 'dims =', dims);
      setScreenshotUri(uri);
      setOriginalSize(dims);
      const active = await StitchSession.hasActiveSession();
      setHasStitchSession(active);
    } catch (e) {
      console.error('[CROP-DBG/App] loadScreenshot error:', e);
    } finally {
      screenshotBusyRef.current = false;
      console.log('[CROP-DBG/App] loadScreenshot END');
    }
  }, []);

  const handleCropConfirm = useCallback(async (crop: CropResult, stayOpen: boolean) => {
    if (!screenshotUri || screenshotBusyRef.current) return;
    screenshotBusyRef.current = true;
    try {
      const croppedUri = await ScreenshotService.crop(screenshotUri, crop);
      await StagingService.stageToQueueOnly(croppedUri, { deleteSrcAfter: true });
      if (!stayOpen) PluginManager.closePluginView();
    } catch {} finally {
      screenshotBusyRef.current = false;
    }
  }, [screenshotUri]);

  const handleLongScreenshot = useCallback(async () => {
    if (!screenshotUri || screenshotBusyRef.current) return;
    screenshotBusyRef.current = true;
    try {
      const rawPath = screenshotUri.replace('file://', '');
      const existingSession = await StitchSession.load();
      if (existingSession) {
        await StitchSession.addImage(rawPath, originalSize.width, originalSize.height);
      } else {
        await StitchSession.startSession(rawPath, originalSize.width, originalSize.height);
      }
      PluginManager.closePluginView();
    } catch {} finally {
      screenshotBusyRef.current = false;
    }
  }, [screenshotUri, originalSize]);

  const handleCropAddToHistory = useCallback(async (crop: CropResult, stayOpen: boolean) => {
    if (!screenshotUri || screenshotBusyRef.current) return;
    screenshotBusyRef.current = true;
    try {
      const croppedUri = await ScreenshotService.crop(screenshotUri, crop);
      await StagingService.saveToHistoryOnly(croppedUri);
      if (!stayOpen) PluginManager.closePluginView();
    } catch {} finally {
      screenshotBusyRef.current = false;
    }
  }, [screenshotUri]);

  const handleStitchConfirm = useCallback(async (session: StitchSessionData) => {
    if (screenshotBusyRef.current) return;
    screenshotBusyRef.current = true;
    setIsCompositing(true);
    try {
      const nativeParams = JSON.stringify({
        direction: session.params.direction,
        overlap: session.params.overlap,
        topLayerIndex: session.params.topLayerIndex,
        images: session.images.map(img => ({
          path: img.path, width: img.width, height: img.height, crop: img.crop,
        })),
      });

      const compositePath: string = await ScreenshotModule.compositeImages(nativeParams);

      const imgs = session.images;
      const effW = imgs.map(img => Math.round(img.width * (1 - img.crop.cropLeft - img.crop.cropRight)));
      const effH = imgs.map(img => Math.round(img.height * (1 - img.crop.cropTop - img.crop.cropBottom)));
      let compW: number, compH: number;
      if (session.params.direction === 'vertical') {
        compW = Math.max(effW[0], effW[1]);
        compH = effH[0] + effH[1] - session.params.overlap;
      } else {
        compW = effW[0] + effW[1] - session.params.overlap;
        compH = Math.max(effH[0], effH[1]);
      }

      await StitchSession.clearSession();
      setHasStitchSession(false);
      setStitchSession(null);
      setScreenshotUri(`file://${compositePath}`);
      setOriginalSize({ width: compW, height: compH });
      setIsCompositing(false);
      setScreen('cropping');
    } catch (e) {
      console.log('Stitch composite error:', e);
      setIsCompositing(false);
      PluginManager.closePluginView();
    } finally {
      screenshotBusyRef.current = false;
    }
  }, []);

  const handleStitchCancel = useCallback(async () => {
    await StitchSession.keepFirstOnly();
    setStitchSession(null);
    PluginManager.closePluginView();
  }, []);

  // ════════════════════════════════════════════════
  //  Lasso screenshot (bubble "St" button) handlers
  // ════════════════════════════════════════════════

  // ════════════════════════════════════════════════

  // ── Mount ──
  useEffect(() => {
    console.log('[App]: ── mount ──');
    ensureInit();

    const fromToolbar    = FloatingToolbarBridge.checkPendingOpenMainSync();
    const toolbarShowing = FloatingToolbarBridge.isShowingSync();
    const pendingScreen  = FloatingToolbarBridge.getPendingScreenSync();
    console.log('[LASSO-DBG/App] mount: fromToolbar=', fromToolbar, 'toolbarShowing=', toolbarShowing, 'pendingScreen=', JSON.stringify(pendingScreen), 'initialScreen=', screen);

    if (fromToolbar) {
      FloatingToolbarBridge.ackPendingScreen();
      FloatingToolbarBridge.hide();
      FloatingBubbleBridge.hide();
      flushPendingTexts();
      reviveIfNeeded();
      setScreen('main');
      setResumeTick(n => n + 1);
      setTimeout(() => FloatingToolbarBridge.ackOpenMain(), 200);
    } else if (pendingScreen) {
      FloatingToolbarBridge.hide();
      flushPendingTexts();
      reviveIfNeeded();
      if (pendingScreen === 'nativeSendHelper') {
        setScreen('nativeHelper');
        setTimeout(() => FloatingToolbarBridge.ackPendingScreen(), 200);
        LassoExtractor.extract().then(extracted => {
          FloatingToolbarBridge.setLassoData(extracted.text, JSON.stringify(extracted.imagePaths));
        }).catch(() => FloatingToolbarBridge.setLassoData('', '[]'));
      } else if (pendingScreen === 'nativeInsertHelper') {
        // Reset any stale screenshot / lasso state left over from previous flows
        // (RN context revives, React state is preserved — explicitly clear)
        resetTransientScreens();
        setScreen('nativeHelper');
        setTimeout(() => FloatingToolbarBridge.ackPendingScreen(), 200);
      } else if (pendingScreen.startsWith('action:')) {
        // text_recv_* 等需要 plugin context 的工具动作。
        // plugin view 仅用于启动阶段的 SDK 调用（getPageSize 等），
        // 激活完成后必须关闭——否则全屏透明的 React View 会拦截笔事件导致手写失效。
        // insertText 通过 IPC 与 note app 通信，不依赖 plugin view 可视状态。
        const action = pendingScreen.slice(7);
        FloatingToolbarBridge.ackPendingScreen();
        setScreen('nativeHelper');
        executeAction(action).then(() => {
          // 无论激活成功与否都关闭 plugin view，释放笔事件
          setTimeout(() => PluginManager.closePluginView(), 300);
        }).catch(() => setTimeout(() => PluginManager.closePluginView(), 300));
      } else {
        setScreen(pendingScreen as AppScreen);
        setResumeTick(n => n + 1);
        setTimeout(() => FloatingToolbarBridge.ackPendingScreen(), 200);
      }
    } else if (toolbarShowing) {
      // Check if this open was actually triggered by a button (e.g. config button 999 or DOC button 300)
      // BEFORE treating it as spurious. Without this, config button while toolbar is showing → crash.
      const earlyPending = checkPendingButton();
      if (earlyPending === 999) {
        // Config button: clear stale pendingScreen, hide toolbar, show main screen
        try { FloatingToolbarBridge.ackPendingScreen(); } catch (_) {}
        FloatingToolbarBridge.hide();
        FloatingBubbleBridge.hide();
        flushPendingTexts();
        reviveIfNeeded();
        setScreen('main');
        setResumeTick(n => n + 1);
      } else if (earlyPending === 300) {
        // DOC screenshot button while toolbar was showing: hide toolbar, start crop flow
        FloatingToolbarBridge.hide();
        FloatingBubbleBridge.hide();
        // loadScreenshot will be called below — but earlyPending already consumed the ID,
        // so re-trigger it manually after subscriptions are set up
        setTimeout(() => loadScreenshot(), 100);
      } else {
        // Genuinely spurious open (showType=0 主按钮 platform side-effect)
        console.log('[App]: spurious open → closing plugin view (subscriptions will still register)');
        PluginManager.closePluginView();
        // Reset stale crop/lasso state from previous sessions (RN context persists state across revivals)
        resetTransientScreens();
        setScreen('main');
      }
    } else {
      FloatingToolbarBridge.hide();
      FloatingBubbleBridge.hide();
      flushPendingTexts();
      reviveIfNeeded();
      // Reset stale state
      resetTransientScreens();
      setScreen('main');
      setResumeTick(n => n + 1);
    }

    const existingMode = getActiveMode();
    if (existingMode) setInsertMode(existingMode);

    Promise.all([loadConfig(), loadClips(), loadBubbleActions()]).then(([configData, clipData, bubbleIds]) => {
      setTools(configData.tools);
      setClips(clipData);
      setBubbleActionIds(bubbleIds);
    });

    FloatingToolbarBridge.checkPermission().then(ok => setHasPermission(ok));

    // ── Subscriptions ──
    const toolTapSub = FloatingToolbarBridge.onToolTap(async ({ toolAction }) => {
      const result = await executeAction(toolAction);
      console.log('[App]: tool result:', result);
      if (typeof result === 'string' &&
          (result.startsWith('Saved to clip') || (result.startsWith('Clip') && result.endsWith('cleared')))) {
        const newClips = await loadClips();
        setClips(newClips);
        refreshToolbar(newClips);
      }
    });

    const clipsChangedSub = DeviceEventEmitter.addListener('clipsChanged', async () => {
      const newClips = await loadClips();
      setClips(newClips);
      refreshToolbar(newClips);
    });

    const longPressSub = FloatingToolbarBridge.onToolLongPress(async ({ toolId }) => {
      if (toolId.startsWith('clip_')) {
        const slot   = toolId.split('_')[1];
        const result = await executeAction(`clip_clear_${slot}`);
        console.log('[App]: long press clear:', result);
        const newClips = await loadClips();
        setClips(newClips);
        refreshToolbar(newClips);
      }
    });

    const openMainSub = FloatingToolbarBridge.onToolbarOpenMain(() => {
      console.log('[App]: onToolbarOpenMain received');
      FloatingToolbarBridge.hide();
      flushPendingTexts();
      reviveIfNeeded();
      const pendingMain = FloatingToolbarBridge.checkPendingOpenMainSync();
      const pendingScr  = FloatingToolbarBridge.getPendingScreenSync();
      if (pendingMain) {
        // Bridge revival: React state is preserved from the previous plugin view session
        // (e.g. cropping). Mount useEffect does NOT re-run here, so
        // the resets it contains don't fire — clear explicitly before switching to 'main'.
        resetTransientScreens();
        FloatingToolbarBridge.ackPendingScreen();
        setScreen('main');
        FloatingToolbarBridge.ackOpenMain();
      } else if (pendingScr) {
        if (pendingScr === 'nativeSendHelper') {
          setScreen('nativeHelper');
          FloatingToolbarBridge.ackPendingScreen();
          LassoExtractor.extract().then(extracted => {
            FloatingToolbarBridge.setLassoData(extracted.text, JSON.stringify(extracted.imagePaths));
          }).catch(() => FloatingToolbarBridge.setLassoData('', '[]'));
        } else if (pendingScr === 'nativeInsertHelper') {
          // Mirror mount-side reset: native insert panel is about to show, no stale crop/lasso.
          resetTransientScreens();
          setScreen('nativeHelper');
          FloatingToolbarBridge.ackPendingScreen();
        } else if (pendingScr.startsWith('action:')) {
          const action = pendingScr.slice(7);
          FloatingToolbarBridge.ackPendingScreen();
          setScreen('nativeHelper');
          executeAction(action).then(() => {
            if (!getActiveMode()) {
              setTimeout(() => PluginManager.closePluginView(), 300);
            }
          }).catch(() => setTimeout(() => PluginManager.closePluginView(), 300));
        } else {
          setScreen(pendingScr as AppScreen);
          FloatingToolbarBridge.ackPendingScreen();
        }
      } else {
        // Fallthrough — ☰ pressed with no explicit pending routing. Treat as "open main".
        resetTransientScreens();
        setScreen('main');
      }
      setResumeTick(n => n + 1);
      setTimeout(() => setResumeTick(n => n + 1), 150);
      setTimeout(() => setResumeTick(n => n + 1), 400);
    });

    const tapSub = FloatingToolbarBridge.onTap(() => {
      FloatingToolbarBridge.hide();
      setScreen('main');
    });

    const permDeniedSub = FloatingToolbarBridge.onPermissionDenied(() => {
      setHasPermission(false);
      setScreen('permission');
    });

    const clipChangeSub = DeviceEventEmitter.addListener('clipboardChanged', async () => {
      const newClips = await loadClips();
      setClips(newClips);
      refreshToolbar(newClips);
    });

    const modeSub = DeviceEventEmitter.addListener(
      'insertModeChanged',
      ({ mode }: { mode: InsertMode | null }) => {
        console.log('[App]: insertModeChanged →', mode);
        setInsertMode(mode);
        if (mode) {
          FloatingToolbarBridge.hide();
          const label = mode === 'nospacing' ? t('bubble_recv_nospacing') : t('bubble_recv_paragraph');
          FloatingBubbleBridge.show(label);
        } else {
          FloatingBubbleBridge.hide();
          if (hasPermissionRef.current) {
            FloatingToolbarBridge.show(injectClipStatus(toolsRef.current, clipsRef.current, null));
          }
        }
      },
    );

    const bubbleLongPressSub = FloatingBubbleBridge.onLongPress(async () => {
      console.log('[App]: bubble long-press → stop mode');
      const curMode = insertModeRef.current;
      if (curMode) {
        await toggleMode(curMode);
      } else {
        FloatingBubbleBridge.hide();
        if (hasPermissionRef.current) {
          FloatingToolbarBridge.show(injectClipStatus(toolsRef.current, clipsRef.current, null));
        }
      }
    });

    const localeSub = DeviceEventEmitter.addListener('localeChanged', (_: unknown) => {
      loadConfig().then(d => setTools(d.tools));
    });

    // 气泡点击 → 暂停文本消费，切回工具栏
    const nativeBubbleTapSub = FloatingBubbleBridge.onTap(() => {
      pauseInsertion();
      FloatingBubbleBridge.hide();
      if (hasPermissionRef.current) {
        FloatingToolbarBridge.show(injectClipStatus(toolsRef.current, clipsRef.current, insertModeRef.current));
      }
    });
    // 气泡拖拽结束 → 更新插入起始位置
    const nativeBubbleDragSub = FloatingBubbleBridge.onDragEnd(({ pageY }) => {
      setInsertTop(pageY);
    });

    const appStateSub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') {
        reviveIfNeeded();
        const pending = FloatingToolbarBridge.checkPendingOpenMainSync();
        if (pending) {
          FloatingToolbarBridge.hide();
          setScreen('main');
          FloatingToolbarBridge.ackOpenMain();
        }
        setResumeTick(n => n + 1);
      }
    });

    const handleButton = (buttonId: number) => {
      if (buttonId === 999) {
        // Config button: clear any stale pendingScreen
        // that would otherwise route the user to a screen they didn't ask for.
        try { FloatingToolbarBridge.ackPendingScreen(); } catch (_) {}
        FloatingToolbarBridge.hide();
        FloatingBubbleBridge.hide();
        setScreen('main');
        setResumeTick(n => n + 1);
        return;
      }
      if (buttonId === 300) {
        // DOC screenshot button: load screenshot and enter crop/stitch mode
        FloatingToolbarBridge.hide();
        FloatingBubbleBridge.hide();
        loadScreenshot();
        return;
      }
      if (buttonId === 100) {
        const pending    = FloatingToolbarBridge.checkPendingOpenMainSync();
        const pendingScr = FloatingToolbarBridge.getPendingScreenSync();
        const isShowing  = FloatingToolbarBridge.isShowingSync();
        if (pending) {
          // Bridge-revival-safe: same reason as onToolbarOpenMain's pendingMain branch.
          resetTransientScreens();
          FloatingToolbarBridge.ackPendingScreen();
          FloatingToolbarBridge.hide();
          setScreen('main');
          setResumeTick(n => n + 1);
          setTimeout(() => FloatingToolbarBridge.ackOpenMain(), 200);
          return;
        }
        if (pendingScr) {
          FloatingToolbarBridge.hide();
          if (pendingScr === 'nativeSendHelper') {
            setScreen('nativeHelper');
            setTimeout(() => FloatingToolbarBridge.ackPendingScreen(), 200);
            LassoExtractor.extract().then(extracted => {
              FloatingToolbarBridge.setLassoData(extracted.text, JSON.stringify(extracted.imagePaths));
            }).catch(() => FloatingToolbarBridge.setLassoData('', '[]'));
          } else if (pendingScr === 'nativeInsertHelper') {
            resetTransientScreens();
            setScreen('nativeHelper');
            setTimeout(() => FloatingToolbarBridge.ackPendingScreen(), 200);
          } else if (pendingScr.startsWith('action:')) {
            const action = pendingScr.slice(7);
            FloatingToolbarBridge.ackPendingScreen();
            setScreen('nativeHelper');
            executeAction(action).then(() => {
              if (!getActiveMode()) {
                setTimeout(() => PluginManager.closePluginView(), 300);
              }
            }).catch(() => setTimeout(() => PluginManager.closePluginView(), 300));
          } else {
            setScreen(pendingScr as AppScreen);
            setResumeTick(n => n + 1);
            setTimeout(() => FloatingToolbarBridge.ackPendingScreen(), 200);
          }
          return;
        }
        if (isShowing) {
          PluginManager.closePluginView();
          return;
        }
        FloatingToolbarBridge.hide();
        FloatingBubbleBridge.hide();
        flushPendingTexts();
        reviveIfNeeded();
        resetTransientScreens();
        setScreen('main');
        setResumeTick(n => n + 1);
      }
    };

    const pending = checkPendingButton();
    if (pending !== null) handleButton(pending);

    const btnSub = DeviceEventEmitter.addListener('quickToolbarButton', ({ id }) => {
      checkPendingButton();
      handleButton(id);
    });

    // NativeImagePanel 发出：直接插入图片并关闭
    let insertClosed = false;
    const nativeInsertSub = DeviceEventEmitter.addListener('nativeInsertImage', ({ path }: { path: string }) => {
      console.log('[INSERT-DBG/App] nativeInsertImage event, path=', path, 'closed=', insertClosed);
      if (insertClosed) {
        console.log('[INSERT-DBG/App] skipped (already inserting)');
        return;
      }
      insertClosed = true;
      if (PluginNoteAPI) {
        console.log('[INSERT-DBG/App] calling PluginNoteAPI.insertImage');
        try {
          const result = PluginNoteAPI.insertImage(path);
          console.log('[INSERT-DBG/App] insertImage returned:', result);
          if (result && typeof result.then === 'function') {
            result.then((r: any) => {
              console.log('[INSERT-DBG/App] insertImage promise resolved:', r);
              // Delete queue file ONLY on success (and only if it's a queue path)
              const isQueuePath = typeof path === 'string' && path.includes('/.plugin_staging/queue/');
              if (r && r.success && isQueuePath) {
                console.log('[INSERT-DBG/App] insert succeeded → deleting queue file');
                FloatingToolbarBridge.deleteQueueFile(path).then(d =>
                  console.log('[INSERT-DBG/App] queue file delete result:', d)
                );
              } else if (!r || !r.success) {
                console.warn('[INSERT-DBG/App] insert FAILED, keeping queue file:', r?.error);
              }
            }).catch((e: unknown) => console.error('[INSERT-DBG/App] insertImage promise rejected:', e));
          }
        } catch (e) {
          console.error('[INSERT-DBG/App] insertImage threw:', e);
        }
      } else {
        console.warn('[INSERT-DBG/App] PluginNoteAPI unavailable');
      }
      // Longer timeout to ensure insert commits — 1200ms was truncating the insert
      setTimeout(() => {
        console.log('[INSERT-DBG/App] closing plugin view after insert');
        insertClosed = false;
        PluginManager.closePluginView();
      }, 2500);
    });
    const nativeCloseSub = DeviceEventEmitter.addListener('nativeClosePluginView', () => {
      PluginManager.closePluginView();
    });

    return () => {
      toolTapSub.remove();
      longPressSub.remove();
      clipsChangedSub.remove();
      openMainSub.remove();
      tapSub.remove();
      permDeniedSub.remove();
      clipChangeSub.remove();
      modeSub.remove();
      localeSub.remove();
      btnSub.remove();
      nativeBubbleTapSub.remove();
      nativeBubbleDragSub.remove();
      bubbleLongPressSub.remove();
      appStateSub.remove();
      nativeInsertSub.remove();
      nativeCloseSub.remove();
    };
  }, []);

  // ── 工具列表变化时自动保存 ──
  const isFirstToolsLoad = useRef(true);
  useEffect(() => {
    if (isFirstToolsLoad.current) { isFirstToolsLoad.current = false; return; }
    if (isValidToolCount(tools.length)) saveConfig({ tools });
  }, [tools]);

  const showToolbarAndClose = useCallback(async () => {
    if (!hasPermission) { setScreen('permission'); return; }
    FloatingToolbarBridge.show(injectClipStatus(toolsRef.current, clipsRef.current, insertModeRef.current));
    setTimeout(() => PluginManager.closePluginView(), 150);
  }, [hasPermission]);

  const removeTool  = useCallback((id: string) => setTools(prev => prev.filter(t => t.id !== id)), []);
  const moveToolUp  = useCallback((idx: number) => {
    if (idx <= 0) return;
    setTools(prev => { const a = [...prev]; [a[idx - 1], a[idx]] = [a[idx], a[idx - 1]]; return a; });
  }, []);
  const moveToolDown = useCallback((idx: number) => {
    setTools(prev => {
      if (idx >= prev.length - 1) return prev;
      const a = [...prev]; [a[idx], a[idx + 1]] = [a[idx + 1], a[idx]]; return a;
    });
  }, []);
  const addTool  = useCallback((tool: ToolItem) => setTools(prev => prev.some(t => t.id === tool.id) ? prev : [...prev, tool]), []);
  const closeAll = useCallback(() => { FloatingToolbarBridge.hide(); PluginManager.closePluginView(); }, []);

  const maxVisible    = layout.cols * layout.rows - 1;
  const overflowCount = Math.max(0, tools.length - maxVisible);

  // ─────────────────────────────────────────────
  //  Render
  // ─────────────────────────────────────────────
  console.log('[LASSO-DBG/App] render: screen=', screen, 'cropUri=', screenshotUri, 'cropDims=', originalSize.width + 'x' + originalSize.height);
  return (
    <View style={st.container}>
      <StatusBar barStyle="dark-content" />
      <View key={`ct-${_resumeTick}`} style={st.centerWrapper}>

        {/* ── Permission ── */}
        {screen === 'permission' && (
          <View style={[st.window, { width: WINDOW_WIDTH, height: WINDOW_HEIGHT * 0.55 }]}>
            <View style={st.sectionHeader}>
              <View style={st.headerRow}>
                <View style={st.permIcon}><Text style={st.permIconText}>!</Text></View>
                <View>
                  <Text style={st.headerLabel}>{t('perm_required')}</Text>
                  <Text style={st.headerSub}>PERMISSION REQUIRED</Text>
                </View>
              </View>
            </View>
            <View style={st.permBody}>
              <Text style={st.permText}>{t('perm_text')}</Text>
              <View style={st.permPkg}><Text style={st.permPkgText}>com.ratta.supernote.pluginhost</Text></View>
              <View style={st.permBtns}>
                <Pressable onPress={() => { FloatingToolbarBridge.requestPermission(); showStatus(t('perm_check_settings')); }} style={st.btnFill}>
                  <Text style={st.btnFillT}>{t('perm_open_settings')}</Text>
                </Pressable>
                <Pressable onPress={async () => {
                  const ok = await FloatingToolbarBridge.checkPermission();
                  setHasPermission(ok);
                  if (ok) { setScreen('main'); showStatus(t('perm_granted')); }
                  else showStatus(t('perm_not_granted'));
                }} style={st.btnLine}>
                  <Text style={st.btnLineT}>{t('perm_recheck')}</Text>
                </Pressable>
                <Pressable onPress={() => setScreen('main')} style={st.btnGhost}>
                  <Text style={st.btnGhostT}>{t('back')}</Text>
                </Pressable>
              </View>
            </View>
            {statusMsg ? <View style={st.toast}><Text style={st.toastT}>{statusMsg}</Text></View> : null}
          </View>
        )}

        {/* ══ MAIN ══ */}
        {screen === 'main' && (
          <View style={[st.window, { width: WINDOW_WIDTH, height: WINDOW_HEIGHT }]}>
            <View style={st.titleBar}>
              <Text style={st.titleText}>{t('app_title')}</Text>
              <Pressable onPress={closeAll} style={st.chipBtn}><Text style={st.chipBtnT}>✕</Text></Pressable>
            </View>
            {statusMsg ? <View style={st.toast}><Text style={st.toastT}>{statusMsg}</Text></View> : null}

            <View style={st.prevSection}>
              <View style={st.prevHeader}>
                <View style={st.headerRow}>
                  <Text style={st.headerLabel}>{t('preview')}</Text>
                  <Text style={st.headerSub}>PREVIEW</Text>
                </View>
              </View>
              <View style={st.prevBody}>
                <View style={st.devFrame}>
                  {[...Array(8)].map((_, i) => (
                    <View key={i} style={{ height: 3, borderRadius: 1, marginBottom: 5, backgroundColor: i % 4 === 0 ? '#CCCCCC' : '#DDDDDD', width: i === 7 ? '25%' : i % 3 === 2 ? '65%' : '90%', marginHorizontal: 10 }} />
                  ))}
                  <View style={[st.miniWrap, dockSide === 'left' ? { left: 0 } : { right: 0 }]}>
                    <MiniToolbarPreview tools={tools} side={dockSide} />
                  </View>
                </View>
                <View style={st.layoutCol}>
                  <View style={st.layoutBadge}>
                    <Text style={st.layoutBadgeT}>{layoutLabel}</Text>
                    <Text style={st.layoutBadgeS}>{t('buttons_count', { n: tools.length })}</Text>
                  </View>
                  <View style={st.layoutMiniRow}>
                    {LAYOUT_OPTIONS.map(lo => {
                      const cur = lo.count === maxVisible;
                      return (
                        <View key={lo.key} style={[st.layoutMini, cur && st.layoutMiniA]}>
                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 1, width: lo.cols * 7 + (lo.cols - 1) }}>
                            {[...Array(lo.count)].map((_, j) => (
                              <View key={j} style={{ width: 6, height: 6, borderRadius: 1, backgroundColor: cur ? (j === 0 ? '#333' : '#AAA') : '#CCC' }} />
                            ))}
                          </View>
                          <Text style={[st.layoutMiniT, cur && st.layoutMiniTA]}>{lo.label}</Text>
                        </View>
                      );
                    })}
                  </View>
                  {!isValidToolCount(tools.length) && (
                    <View style={st.warnBadge}><Text style={st.warnBadgeT}>{t('tools_count_hint', { n: tools.length })}</Text></View>
                  )}
                </View>
              </View>
            </View>

            <View style={st.toolSection}>
              <View style={st.toolHeader}>
                <View style={st.headerRow}>
                  <Text style={st.headerLabel}>{t('tool_list')}</Text>
                  <Text style={st.headerSub}>TOOLS · {tools.length}</Text>
                </View>
                <Pressable onPress={() => { setCatFilter('all'); setScreen('add_tool'); }} style={st.addBtn}>
                  <Text style={st.addBtnT}>{t('add_tool')}</Text>
                </Pressable>
              </View>
              <ScrollView style={st.toolScroll}>
                {tools.length === 0 && (
                  <View style={st.empty}>
                    <Text style={st.emptyT}>{t('empty_tools')}</Text>
                    <Text style={st.emptyH}>{t('empty_tools_hint')}</Text>
                  </View>
                )}
                {injectClipStatus(tools, clips, insertMode).map((tool, idx) => {
                  const muted = idx >= maxVisible;
                  return (
                    <View key={tool.id + idx} style={st.toolRow}>
                      <View style={[st.idxBadge, muted && st.idxBadgeM]}>
                        <Text style={[st.idxBadgeT, muted && st.idxBadgeTM]}>{idx + 1}</Text>
                      </View>
                      <View style={[st.toolIcon, muted && st.toolIconM]}>
                        <Text style={[st.toolIconT, muted && st.toolIconTM]}>{tool.icon}</Text>
                      </View>
                      <View style={st.toolInfo}>
                        <Text style={[st.toolName, muted && st.toolNameM]}>{tool.name}</Text>
                        <Text style={st.toolAct}>{tool.action}</Text>
                      </View>
                      <View style={st.moveBtns}>
                        <Pressable onPress={() => moveToolUp(idx)} style={st.moveBtn} hitSlop={8}><Text style={st.moveBtnT}>▲</Text></Pressable>
                        <Pressable onPress={() => moveToolDown(idx)} style={st.moveBtn} hitSlop={8}><Text style={st.moveBtnT}>▼</Text></Pressable>
                      </View>
                      <Pressable onPress={() => removeTool(tool.id)} style={st.delBtn} hitSlop={8}>
                        <Text style={st.delBtnT}>✕</Text>
                      </Pressable>
                    </View>
                  );
                })}
              </ScrollView>
              {overflowCount > 0 && (
                <View style={st.overflowBar}>
                  <Text style={st.overflowT}>{t('overflow_warn', { max: maxVisible, layout: layoutLabel, extra: overflowCount })}</Text>
                </View>
              )}
            </View>

            {/* ── 气泡快捷按钮设置 ── */}
            <View style={st.bubbleSection}>
              <View style={st.bubbleHeader}>
                <Text style={st.headerLabel}>{t('bubble_actions_title')}</Text>
                <Text style={st.headerSub}>{t('bubble_actions_hint')}</Text>
              </View>
              <View style={st.bubbleRow}>
                {allBubbleActions.map(ba => {
                  const enabled = bubbleActionIds.includes(ba.id);
                  return (
                    <Pressable
                      key={ba.id}
                      onPress={async () => {
                        const next = enabled
                          ? bubbleActionIds.filter(x => x !== ba.id)
                          : [...bubbleActionIds, ba.id];
                        setBubbleActionIds(next);
                        await saveBubbleActions(next);
                        refreshBubbleActions();
                      }}
                      style={[st.bubbleChip, enabled && st.bubbleChipActive]}
                    >
                      <Text style={[st.bubbleChipIcon, enabled && st.bubbleChipIconActive]}>{ba.icon}</Text>
                      <Text style={[st.bubbleChipLabel, enabled && st.bubbleChipLabelActive]}>{ba.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View style={st.bottomBar}>
              <Pressable onPress={closeAll} style={st.btnFill}><Text style={st.btnFillT}>{t('close')}</Text></Pressable>
            </View>
          </View>
        )}

        {/* ══ ADD TOOL ══ */}
        {screen === 'add_tool' && (
          <View style={[st.window, { width: WINDOW_WIDTH, height: WINDOW_HEIGHT }]}>
            <View style={st.titleBar}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Pressable onPress={() => setScreen('main')} style={st.backBtn}>
                  <Text style={st.backBtnT}>{'‹'}</Text>
                </Pressable>
                <Text style={st.titleText}>{t('add_tool_title')}</Text>
              </View>
              <View />
            </View>
            <View style={st.catRow}>
              {CAT_FILTERS.map(cf => (
                <Pressable key={cf.key} onPress={() => setCatFilter(cf.key)} style={[st.catPill, catFilter === cf.key && st.catPillA]}>
                  <Text style={[st.catPillT, catFilter === cf.key && st.catPillTA]}>{t(cf.labelKey as any)}</Text>
                </Pressable>
              ))}
            </View>
            <ScrollView style={st.toolScroll}>
              {injectClipStatus(getAvailableTools(), clips, insertMode)
                .filter(tool => catFilter === 'all' || getToolCategory(tool.id) === catFilter)
                .map(tool => {
                  const added = tools.some(t => t.id === tool.id);
                  return (
                    <Pressable key={tool.id} onPress={() => !added && addTool(tool)} style={[st.toolRow, added && st.toolRowDim]}>
                      <View style={[st.toolIcon, added && st.toolIconM]}>
                        <Text style={[st.toolIconT, added && st.toolIconTM]}>{tool.icon}</Text>
                      </View>
                      <View style={st.toolInfo}>
                        <Text style={st.toolName}>{tool.name}</Text>
                        <Text style={st.toolAct}>{tool.action}</Text>
                      </View>
                      {added
                        ? <View style={st.addedBadge}><Text style={st.addedBadgeT}>{t('added')}</Text></View>
                        : <View style={st.addIconBtn}><Text style={st.addIconBtnT}>+</Text></View>}
                    </Pressable>
                  );
                })}
            </ScrollView>
            <View style={st.bottomBar}>
              <Text style={st.footerCount}>{t('selected_count', { n: tools.length })} · {layoutLabel}</Text>
              <Pressable onPress={() => setScreen('main')} style={st.btnFill}><Text style={st.btnFillT}>{t('done')}</Text></Pressable>
            </View>
          </View>
        )}

        {/* ── Native Helper (NativeImagePanel / NativeSendPanel 透明占位) ── */}
        {screen === 'nativeHelper' && (
          <View style={{ flex: 1, backgroundColor: 'transparent' }} />
        )}

      </View>

      {/* ══ DOC Screenshot Crop ══ (full-screen, outside centerWrapper) */}
      {screen === 'cropping' && screenshotUri && originalSize.width > 0 && (
        <View style={StyleSheet.absoluteFill}>
          <CropOverlay
            key={screenshotUri}
            imageUri={screenshotUri}
            originalWidth={originalSize.width}
            originalHeight={originalSize.height}
            onConfirm={handleCropConfirm}
            onLongScreenshot={handleLongScreenshot}
            onAddToHistory={handleCropAddToHistory}
            onClose={() => PluginManager.closePluginView()}
            hasStitchSession={hasStitchSession}
          />
        </View>
      )}

      {/* ══ DOC Stitch Editor ══ (full-screen) */}
      {screen === 'stitching' && stitchSession && (
        <View style={StyleSheet.absoluteFill}>
          <StitchEditor
            session={stitchSession}
            onConfirm={handleStitchConfirm}
            onCancel={handleStitchCancel}
            disabled={isCompositing}
          />
        </View>
      )}

      {/* ══ Lasso Screenshot (bubble "St" → freehand lasso → AI) ══ */}
    </View>
  );
}

// ════════════════════════════════════════════════
//  Styles — E-ink 编辑式设计语言
// ════════════════════════════════════════════════

const st = StyleSheet.create({
  container:     { flex: 1, backgroundColor: 'transparent' },
  centerWrapper: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  window: { backgroundColor: '#FFFFFF', borderWidth: 1.5, borderColor: '#444444', borderRadius: 8, overflow: 'hidden' },

  titleBar:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#D8D8D8' },
  titleText: { fontSize: 17, fontWeight: '700', color: '#111111' },
  chipBtn:   { paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: '#000000', borderRadius: 3, backgroundColor: '#FFFFFF' },
  chipBtnT:  { fontSize: 12, fontWeight: '700', color: '#000000' },
  backBtn:   { width: 28, height: 28, borderWidth: 1, borderColor: '#CCCCCC', borderRadius: 3, justifyContent: 'center', alignItems: 'center' },
  backBtnT:  { fontSize: 18, fontWeight: '500', color: '#333333', marginTop: -2 },

  toast:  { paddingHorizontal: 14, paddingVertical: 6, backgroundColor: '#111111' },
  toastT: { fontSize: 11, fontWeight: '500', color: '#FFFFFF' },

  sectionHeader: { paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#E8E8E8' },
  headerRow:     { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headerLabel:   { fontSize: 12, fontWeight: '700', color: '#222222' },
  headerSub:     { fontSize: 9,  fontWeight: '400', color: '#AAAAAA' },

  prevSection: { borderBottomWidth: 1, borderBottomColor: '#E0E0E0', backgroundColor: '#FAFAF8' },
  prevHeader:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingTop: 8, paddingBottom: 6 },
  prevBody:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10, paddingBottom: 10, gap: 12 },

  devFrame:  { width: 120, height: 155, backgroundColor: '#E8E8E8', borderRadius: 6, borderWidth: 1, borderColor: '#888888', position: 'relative', overflow: 'hidden', paddingTop: 10 },
  miniWrap:  { position: 'absolute', top: '40%' },

  layoutCol:     { alignItems: 'center', gap: 6 },
  layoutBadge:   { paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1.5, borderColor: '#444444', borderRadius: 4, alignItems: 'center' },
  layoutBadgeT:  { fontSize: 16, fontWeight: '700', color: '#111111' },
  layoutBadgeS:  { fontSize: 8, color: '#888888', marginTop: 1 },
  layoutMiniRow: { flexDirection: 'row', gap: 4 },
  layoutMini:    { alignItems: 'center', paddingVertical: 3, paddingHorizontal: 5, borderRadius: 3, borderWidth: 1, borderColor: '#DDDDDD', backgroundColor: '#FAFAFA' },
  layoutMiniA:   { borderColor: '#000000', backgroundColor: '#F5F3ED' },
  layoutMiniT:   { fontSize: 8, color: '#AAAAAA', marginTop: 2 },
  layoutMiniTA:  { color: '#000000', fontWeight: '700' },
  warnBadge:     { paddingVertical: 2, paddingHorizontal: 6, backgroundColor: '#FFF5F5', borderRadius: 3, borderWidth: 1, borderColor: '#EECCCC' },
  warnBadgeT:    { fontSize: 8, color: '#CC4444' },

  toolSection: { flex: 1 },
  toolHeader:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#EEEEEE', backgroundColor: '#FAFAFA' },
  addBtn:      { paddingVertical: 4, paddingHorizontal: 12, borderWidth: 1.5, borderColor: '#000000', borderRadius: 3, backgroundColor: '#FFFFFF' },
  addBtnT:     { fontSize: 11, fontWeight: '600', color: '#000000' },
  toolScroll:  { flex: 1 },

  toolRow:    { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#F0F0F0', gap: 8 },
  toolRowDim: { opacity: 0.4 },

  idxBadge:   { width: 18, height: 18, borderRadius: 9, backgroundColor: '#000000', justifyContent: 'center', alignItems: 'center' },
  idxBadgeM:  { backgroundColor: '#DDDDDD' },
  idxBadgeT:  { fontSize: 9, fontWeight: '700', color: '#FFFFFF' },
  idxBadgeTM: { color: '#999999' },

  toolIcon:   { width: 36, height: 36, borderWidth: 1.5, borderColor: '#888888', borderRadius: 4, justifyContent: 'center', alignItems: 'center', backgroundColor: '#FFFFFF' },
  toolIconM:  { borderColor: '#DDDDDD', backgroundColor: '#F8F8F8' },
  toolIconT:  { fontSize: 13, fontWeight: '700', color: '#333333' },
  toolIconTM: { color: '#BBBBBB' },

  toolInfo:  { flex: 1 },
  toolName:  { fontSize: 13, fontWeight: '600', color: '#111111' },
  toolNameM: { color: '#AAAAAA' },
  toolAct:   { fontSize: 9, color: '#AAAAAA', marginTop: 1 },

  moveBtns: { flexDirection: 'column', gap: 2 },
  moveBtn:  { width: 24, height: 18, borderWidth: 1, borderColor: '#DDDDDD', borderRadius: 2, justifyContent: 'center', alignItems: 'center', backgroundColor: '#FAFAFA' },
  moveBtnT: { fontSize: 8, color: '#888888' },
  delBtn:   { width: 24, height: 24, borderWidth: 1, borderColor: '#E0C0C0', borderRadius: 3, justifyContent: 'center', alignItems: 'center', backgroundColor: '#FFF8F8' },
  delBtnT:  { fontSize: 10, color: '#CC6666' },

  empty:  { paddingVertical: 40, alignItems: 'center' },
  emptyT: { fontSize: 14, fontWeight: '600', color: '#999999' },
  emptyH: { fontSize: 11, color: '#BBBBBB', marginTop: 4 },

  overflowBar: { paddingHorizontal: 14, paddingVertical: 6, backgroundColor: '#FFFBE6', borderTopWidth: 1, borderTopColor: '#F0E8C0' },
  overflowT:   { fontSize: 9, color: '#A08800' },

  bubbleSection:        { borderTopWidth: 1, borderTopColor: '#E8E8E8', paddingHorizontal: 14, paddingVertical: 8, backgroundColor: '#FAFAF8' },
  bubbleHeader:         { marginBottom: 6 },
  bubbleRow:            { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  bubbleChip:           { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 5, paddingHorizontal: 10, borderWidth: 1.5, borderColor: '#DDDDDD', borderRadius: 4, backgroundColor: '#FFFFFF' },
  bubbleChipActive:     { borderColor: '#000000', backgroundColor: '#F5F3ED' },
  bubbleChipIcon:       { fontSize: 11, fontWeight: '700' as const, color: '#BBBBBB' },
  bubbleChipIconActive: { color: '#000000' },
  bubbleChipLabel:      { fontSize: 10, color: '#AAAAAA' },
  bubbleChipLabelActive:{ color: '#000000', fontWeight: '600' as const },

  catRow:    { flexDirection: 'row', flexWrap: 'wrap', gap: 4, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  catPill:   { paddingVertical: 3, paddingHorizontal: 10, borderWidth: 1, borderColor: '#DDDDDD', borderRadius: 12, backgroundColor: '#FFFFFF' },
  catPillA:  { backgroundColor: '#000000', borderColor: '#000000' },
  catPillT:  { fontSize: 10, color: '#888888' },
  catPillTA: { color: '#FFFFFF' },

  addedBadge:  { paddingVertical: 2, paddingHorizontal: 8, borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 3 },
  addedBadgeT: { fontSize: 9, color: '#BBBBBB' },
  addIconBtn:  { width: 26, height: 26, borderWidth: 1.5, borderColor: '#000000', borderRadius: 3, justifyContent: 'center', alignItems: 'center' },
  addIconBtnT: { fontSize: 14, fontWeight: '700', color: '#000000' },
  footerCount: { fontSize: 10, color: '#888888' },

  bottomBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: '#D8D8D8', paddingHorizontal: 14, paddingVertical: 10 },

  btnFill:   { paddingVertical: 8, paddingHorizontal: 18, backgroundColor: '#000000', borderRadius: 3 },
  btnFillT:  { fontSize: 13, fontWeight: '600', color: '#FFFFFF' },
  btnLine:   { paddingVertical: 8, paddingHorizontal: 18, borderWidth: 1.5, borderColor: '#000000', backgroundColor: '#FFFFFF', borderRadius: 3 },
  btnLineT:  { fontSize: 13, fontWeight: '500', color: '#000000' },
  btnGhost:  { paddingVertical: 8, paddingHorizontal: 14, borderWidth: 1, borderColor: '#CCCCCC', borderRadius: 3, backgroundColor: '#FFFFFF' },
  btnGhostT: { fontSize: 13, color: '#888888' },
  btnDis:    { opacity: 0.35 },

  permIcon:     { width: 30, height: 30, borderWidth: 2, borderColor: '#000000', borderRadius: 15, justifyContent: 'center', alignItems: 'center' },
  permIconText: { fontSize: 15, fontWeight: '700', color: '#000000' },
  permBody:     { flex: 1, paddingHorizontal: 18, paddingVertical: 16 },
  permText:     { fontSize: 13, color: '#444444', lineHeight: 22, marginBottom: 12 },
  permPkg:      { paddingVertical: 5, paddingHorizontal: 10, backgroundColor: '#F8F8F8', borderRadius: 3, borderWidth: 1, borderColor: '#EEEEEE', marginBottom: 18 },
  permPkgText:  { fontSize: 9, color: '#999999' },
  permBtns:     { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
});

export default App;