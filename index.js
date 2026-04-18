/**
 * index.js — QuickToolbar 插件入口
 *
 * 主按钮 (id=100, showType=0): 直接显示 native 悬浮工具栏，不打开 plugin view。
 * 工具点击 / 长按由本文件的模块级监听器处理（进程常驻，不依赖 App.tsx mount）。
 * insert_image / lasso_send 等需要 UI 的动作通过 FloatingToolbarBridge.openPanel() 打开 plugin view。
 * Config Button（插件管理页）→ 打开 plugin view → App.tsx 显示主配置界面。
 */

import { AppRegistry, Image, DeviceEventEmitter } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import { PluginManager } from 'sn-plugin-lib';
import { ensureInit } from './components/BackgroundService';
import { setPendingButton } from './pendingButton';
import { warmupCache, getCachedConfig, getCachedClips, injectClipStatus, loadClips } from './components/ToolPresets';
import FloatingToolbarBridge from './components/FloatingToolbarBridge';
import { executeAction } from './components/ToolActions';
import { setLocale } from './components/i18n';

// 1. 注册 RN 组件
AppRegistry.registerComponent(appName, () => App);

// 2. 初始化 SDK + 后台服务 + 预热配置缓存
PluginManager.init();
ensureInit();
warmupCache();

// 注册 Config Button（插件管理页入口 → 打开 plugin view 显示设置界面）
PluginManager.registerConfigButton();
PluginManager.registerConfigButtonListener({
  onClick() {
    console.log('[index]: config button clicked');
    setPendingButton(999);
  },
});

// 跟随系统语言变化
PluginManager.registerLangListener({
  onMsg(msg) {
    const lang = msg.lang || '';
    const locale = lang.toLowerCase().startsWith('zh') ? 'zh' : 'en';
    setLocale(locale);
  },
});

// 3. 工具点击处理（进程常驻，不依赖 App.tsx mount）
FloatingToolbarBridge.onToolTap(async ({ toolAction }) => {
  console.log('[index]: onToolTap action=', toolAction);

  if (toolAction === 'insert_image') {
    FloatingToolbarBridge.openPanel('insertImage');
    return;
  }
  if (toolAction === 'lasso_send') {
    FloatingToolbarBridge.openPanel('nativeSendHelper');
    return;
  }

  const result = await executeAction(toolAction);
  console.log('[index]: executeAction result=', result);

  // clip 变化后刷新工具栏图标
  if (typeof result === 'string' &&
      (result.startsWith('Saved to clip') || (result.startsWith('Clip') && result.endsWith('cleared')))) {
    const newClips = await loadClips();
    const config = getCachedConfig();
    if (config) {
      FloatingToolbarBridge.updateTools(injectClipStatus(config.tools, newClips, null));
    }
  }
});

FloatingToolbarBridge.onToolLongPress(async ({ toolId }) => {
  if (toolId.startsWith('clip_')) {
    const slot = toolId.split('_')[1];
    await executeAction(`clip_clear_${slot}`);
    const newClips = await loadClips();
    const config = getCachedConfig();
    if (config) {
      FloatingToolbarBridge.updateTools(injectClipStatus(config.tools, newClips, null));
    }
  }
});

// 4. 主按钮事件
let lastCaptureTime = 0;
const CAPTURE_DEBOUNCE = 3000;

PluginManager.registerButtonListener({
  onButtonPress(event) {
    console.log('[index]: button id=', event.id);

    // DOC screenshot button: captureAndReopen
    if (event.id === 300) {
      const now = Date.now();
      if (now - lastCaptureTime < CAPTURE_DEBOUNCE) return;
      lastCaptureTime = now;
      const { NativeModules } = require('react-native');
      const { ScreenshotModule } = NativeModules;
      if (ScreenshotModule) {
        ScreenshotModule.captureAndReopen(3000).catch(() => {});
      }
      setPendingButton(event.id);
      DeviceEventEmitter.emit('quickToolbarButton', { id: event.id });
      return;
    }

    if (event.id === 100) {
      // showType=0: plugin view 不打开，直接显示 native 悬浮工具栏
      const config = getCachedConfig();
      const clips = getCachedClips();
      if (config && clips) {
        FloatingToolbarBridge.show(injectClipStatus(config.tools, clips, null));
      } else {
        // 缓存未就绪（context 刚重建）：先用默认工具立即显示，预热完成后更新
        const { getAvailableTools } = require('./components/ToolPresets');
        const defaultClips = { '1': null, '2': null, '3': null, '4': null, '5': null, '6': null };
        FloatingToolbarBridge.show(injectClipStatus(getAvailableTools().slice(0, 8), defaultClips, null));
        warmupCache().then(() => {
          const c = getCachedConfig();
          const cl = getCachedClips();
          if (!c || !cl) return;
          FloatingToolbarBridge.updateTools(injectClipStatus(c.tools, cl, null));
        });
      }
      return;
    }
    setPendingButton(event.id);
    DeviceEventEmitter.emit('quickToolbarButton', { id: event.id });
  },
});

// 5. 注册侧栏按钮 (showType=0: 不打开 plugin view，直接走 onButtonPress)
PluginManager.registerButton(1, ['NOTE'], {
  id: 100,
  name: 'QuickBar',
  icon: Image.resolveAssetSource(require('./assets/toolbar_icon.png')).uri,
  showType: 0,
});

// 6. DOC 上下文：截图裁切按钮 (showType=1: 打开 plugin view 显示裁切界面)
PluginManager.registerButton(1, ['DOC'], {
  id: 300,
  name: JSON.stringify({ en: 'Screenshot Crop', zh_CN: '截图裁切' }),
  icon: Image.resolveAssetSource(require('./assets/toolbar_icon.png')).uri,
  showType: 1,
});
