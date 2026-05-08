/**
 * i18n — Inkling 中英双语字符串
 *
 * - 通过 NativeModules.SettingsManager (iOS) / I18nManager (Android) 读取设备语言
 * - 覆盖：locale 以 "zh" 开头 → 中文，否则英文
 * - 可通过 setLocale('zh'|'en') 手动切换
 * - 通过 t('key') 获取字符串，或 t('key', { a: 1 }) 插值
 * - 监听 'localeChanged' 事件触发重新渲染
 */

import { NativeModules, Platform, DeviceEventEmitter } from 'react-native';

export type Locale = 'zh' | 'en';

const STRINGS = {
  // ── App / 总览 ──
  app_title:               { zh: 'Inkling',          en: 'Inkling' },
  app_subtitle:            { zh: '把文档转成 Supernote 原生位图 PDF',
                             en: 'Convert documents to Supernote-native bitmap PDF' },

  // ── 通用 ──
  back:                    { zh: '返回',         en: 'Back' },
  cancel:                  { zh: '取消',         en: 'Cancel' },
  confirm:                 { zh: '确定',         en: 'OK' },
  done:                    { zh: '完成',         en: 'Done' },
  close:                   { zh: '关闭',         en: 'Close' },
  retry:                   { zh: '重试',         en: 'Retry' },

  // ── Home ──
  home_pick:               { zh: '选择文档',     en: 'Pick a document' },
  home_supports:           { zh: '支持 TXT / Markdown / EPUB / DOCX / PDF',
                             en: 'TXT / Markdown / EPUB / DOCX / PDF' },
  home_recent:             { zh: '最近转换',     en: 'Recent' },

  // ── Configure ──
  cfg_input:               { zh: '输入文件',     en: 'Input' },
  cfg_orientation:         { zh: '排版方向',     en: 'Orientation' },
  cfg_horizontal:          { zh: '横排',         en: 'Horizontal' },
  cfg_vertical:            { zh: '竖排（右→左）', en: 'Vertical (RTL)' },
  cfg_format:              { zh: '页面尺寸',     en: 'Page size' },
  cfg_format_portrait:     { zh: '竖向 1920×2560', en: 'Portrait 1920×2560' },
  cfg_format_split:        { zh: '横向半页 2560×960', en: 'Landscape split 2560×960' },
  cfg_font_size:           { zh: '字号',         en: 'Font size' },
  cfg_advanced:            { zh: '高级设置 →',   en: 'Advanced →' },
  cfg_convert:             { zh: '开始转换',     en: 'Convert' },

  // ── Advanced ──
  adv_title:               { zh: '高级设置',     en: 'Advanced settings' },
  adv_section_layout:      { zh: '版面',         en: 'Layout' },
  adv_section_render:      { zh: '渲染',         en: 'Render' },
  adv_section_output:      { zh: '输出',         en: 'Output' },
  adv_page_width:          { zh: '页面宽 (px)',  en: 'Page width (px)' },
  adv_page_height:         { zh: '页面高 (px)',  en: 'Page height (px)' },
  adv_margin:              { zh: '页边距 (px)',  en: 'Margin (px)' },
  adv_line_height:         { zh: '行距倍率',     en: 'Line height ×' },
  adv_paragraph_spacing:   { zh: '段后间距 (px)', en: 'Paragraph spacing (px)' },
  adv_jpeg_quality:        { zh: 'JPEG 质量 (1–100)', en: 'JPEG quality (1–100)' },
  adv_threads:             { zh: '并行线程数 (0=自动)', en: 'Threads (0=auto)' },
  adv_text_layer:          { zh: '嵌入文字层（可搜索/选中）',
                             en: 'Embed text layer (searchable)' },
  adv_bookmarks:           { zh: '生成书签目录', en: 'Generate bookmarks' },
  adv_split_landscape:     { zh: '横向半页拆分', en: 'Landscape half-page split' },
  adv_apply:               { zh: '应用',         en: 'Apply' },

  // ── Progress ──
  prog_title:              { zh: '正在转换',     en: 'Converting' },
  stage_parse:             { zh: '解析',         en: 'Parse' },
  stage_layout:            { zh: '排版',         en: 'Layout' },
  stage_render:            { zh: '渲染',         en: 'Render' },
  stage_package:           { zh: '生成 PDF',     en: 'Package' },
  stage_done:              { zh: '完成',         en: 'Done' },

  // ── Result ──
  result_ok_title:         { zh: '已完成',       en: 'Finished' },
  result_err_title:        { zh: '转换失败',     en: 'Failed' },
  result_output:           { zh: '输出位置',     en: 'Output' },
  result_again:            { zh: '转换下一个',   en: 'Convert another' },
};

type StringKey = keyof typeof STRINGS;

function detectLocale(): Locale {
  try {
    let lang: string | undefined;
    if (Platform.OS === 'ios') {
      lang = NativeModules.SettingsManager?.settings?.AppleLocale
           || NativeModules.SettingsManager?.settings?.AppleLanguages?.[0];
    } else {
      lang = NativeModules.I18nManager?.localeIdentifier;
    }
    if (lang && lang.toLowerCase().startsWith('zh')) return 'zh';
  } catch {}
  return 'en';
}

let _locale: Locale = detectLocale();

export function getLocale(): Locale {
  return _locale;
}

export function setLocale(loc: Locale): void {
  if (loc !== _locale) {
    _locale = loc;
    DeviceEventEmitter.emit('localeChanged', { locale: loc });
  }
}

export function t(key: StringKey, params?: Record<string, string | number>): string {
  const entry = STRINGS[key];
  let s = entry ? entry[_locale] || entry.en : String(key);
  if (params) {
    for (const k of Object.keys(params)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(params[k]));
    }
  }
  return s;
}
