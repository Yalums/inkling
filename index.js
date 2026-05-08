/**
 * index.js — Inkling 插件入口（M0 占位版）
 *
 * 仅注册 Config Button：从插件管理页打开 plugin view → App.tsx 渲染主界面。
 * 不挂任何 NOTE / DOC 侧栏按钮。
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import { PluginManager } from 'sn-plugin-lib';
import { setPendingButton } from './pendingButton';
import { setLocale } from './components/i18n';

AppRegistry.registerComponent(appName, () => App);
PluginManager.init();

PluginManager.registerConfigButton();
PluginManager.registerConfigButtonListener({
  onClick() {
    console.log('[index]: config button clicked');
    setPendingButton(999);
  },
});

PluginManager.registerLangListener({
  onMsg(msg) {
    const lang = (msg.lang || '').toLowerCase();
    setLocale(lang.startsWith('zh') ? 'zh' : 'en');
  },
});
