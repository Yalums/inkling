/**
 * ToolPresets — 单一工具配置管理 + 剪贴板状态
 *
 * 工具名称通过 i18n.t() 动态本地化，在 load 时注入。
 * 只有一套持久化配置（key=1），删除了多预设切换。
 * 有效布局：4 按钮 (2×2)、6 按钮 (3×2)、8 按钮 (4×2)。
 */

import { NativeModules } from 'react-native';
import { ToolItem } from './FloatingToolbarBridge';
import { t } from './i18n';

const { FloatingToolbar } = NativeModules;

const CONFIG_STORE_KEY = 1;
const CLIP_STORE_KEY = 99;

/**
 * 有效的 JS 工具数量（☰ 占一格，总格数 = tools + 1）
 * 3×2=6格 → 5工具
 * 4×2=8格 → 7工具
 * 3×3=9格 → 8工具
 * 4×3=12格 → 11工具
 */
export const VALID_TOOL_COUNTS = [5, 7, 8, 11];

export function isValidToolCount(n: number): boolean {
  return VALID_TOOL_COUNTS.includes(n);
}

/** 根据工具数量返回布局 [cols, rows]（☰ 已算入总格数） */
export function getLayoutForCount(n: number): { cols: number; rows: number } {
  if (n <= 5)  return { cols: 3, rows: 2 };
  if (n <= 7)  return { cols: 4, rows: 2 };
  if (n <= 8)  return { cols: 3, rows: 3 };
  return       { cols: 4, rows: 3 };
}

export interface ConfigData {
  tools: ToolItem[];
}

export interface ClipData {
  [slot: string]: string | null;  // slot "1"-"6" → sticker name or null
}

/** 工具分类 */
export type ToolCategory = 'layer' | 'insert' | 'text' | 'lasso' | 'clip';

/** 工具目录定义（静态，不含本地化后的名称） */
const TOOL_DEFS: { id: string; icon: string; action: string; nameKey: string; nameParams?: any; category: ToolCategory }[] = [
  { id: 'layer_prev',         icon: 'L↑', action: 'layer_prev',          nameKey: 'tool_layer_prev',     category: 'layer' },
  { id: 'layer_next',         icon: 'L↓', action: 'layer_next',          nameKey: 'tool_layer_next',     category: 'layer' },
  { id: 'ins_image',          icon: 'Im', action: 'insert_image',        nameKey: 'tool_insert_image',   category: 'insert' },
  { id: 'ins_doc_screenshot', icon: 'Sc', action: 'insert_doc_screenshot', nameKey: 'tool_insert_doc_screenshot', category: 'insert' },
  { id: 'text_recv_nospacing',icon: 'T═', action: 'text_recv_nospacing', nameKey: 'tool_text_nospacing', category: 'text' },
  { id: 'text_recv_paragraph',icon: 'T¶', action: 'text_recv_paragraph', nameKey: 'tool_text_paragraph', category: 'text' },
  { id: 'clip_1',             icon: 'c1', action: 'clip_paste_1',        nameKey: 'tool_clip', nameParams: { n: 1 }, category: 'clip' },
  { id: 'clip_2',             icon: 'c2', action: 'clip_paste_2',        nameKey: 'tool_clip', nameParams: { n: 2 }, category: 'clip' },
  { id: 'clip_3',             icon: 'c3', action: 'clip_paste_3',        nameKey: 'tool_clip', nameParams: { n: 3 }, category: 'clip' },
  { id: 'clip_4',             icon: 'c4', action: 'clip_paste_4',        nameKey: 'tool_clip', nameParams: { n: 4 }, category: 'clip' },
  { id: 'clip_5',             icon: 'c5', action: 'clip_paste_5',        nameKey: 'tool_clip', nameParams: { n: 5 }, category: 'clip' },
  { id: 'clip_6',             icon: 'c6', action: 'clip_paste_6',        nameKey: 'tool_clip', nameParams: { n: 6 }, category: 'clip' },
];

// ── 气泡 Action 按钮定义（显示在文本接收悬浮窗上） ──

export interface BubbleAction {
  id: string;
  icon: string;
  label: string;
  action: string;
}

/** 气泡 action 按钮候选列表 */
const BUBBLE_ACTION_DEFS: { id: string; icon: string; action: string; nameKey: string }[] = [
  { id: 'lasso_ai',       icon: 'AI', action: 'lasso_ai',       nameKey: 'tool_lasso_ai' },
  { id: 'lasso_send',     icon: 'Sd', action: 'lasso_send',     nameKey: 'tool_lasso_send' },
  { id: 'screenshot_ai',  icon: 'St', action: 'screenshot_ai',  nameKey: 'tool_screenshot_ai' },
];

/** 获取所有可选的气泡 action（带本地化 label） */
export function getAvailableBubbleActions(): BubbleAction[] {
  return BUBBLE_ACTION_DEFS.map(d => ({
    id: d.id,
    icon: d.icon,
    label: t(d.nameKey as any),
    action: d.action,
  }));
}

/** 默认启用的气泡 action ID 列表 */
const DEFAULT_BUBBLE_ACTIONS = ['lasso_ai', 'lasso_send', 'screenshot_ai'];

const BUBBLE_ACTION_STORE_KEY = 98;

/** 加载气泡 action 配置（返回启用的 action ID 数组） */
export async function loadBubbleActions(): Promise<string[]> {
  try {
    const json = await FloatingToolbar?.loadPreset(BUBBLE_ACTION_STORE_KEY);
    if (json) {
      const data = JSON.parse(json);
      if (Array.isArray(data.enabledIds)) return data.enabledIds;
    }
  } catch (e) {
    console.warn('[ToolPresets]: loadBubbleActions:', e);
  }
  return DEFAULT_BUBBLE_ACTIONS;
}

/** 保存气泡 action 配置 */
export async function saveBubbleActions(enabledIds: string[]): Promise<void> {
  try {
    await FloatingToolbar?.savePreset(BUBBLE_ACTION_STORE_KEY, JSON.stringify({ enabledIds }));
  } catch (e) {
    console.warn('[ToolPresets]: saveBubbleActions:', e);
  }
}

/** 根据启用的 ID 列表返回完整的 BubbleAction 对象（用于传给 native） */
export function resolveBubbleActions(enabledIds: string[]): BubbleAction[] {
  return enabledIds
    .map(id => {
      const def = BUBBLE_ACTION_DEFS.find(d => d.id === id);
      if (!def) return null;
      return { id: def.id, icon: def.icon, label: t(def.nameKey as any), action: def.action };
    })
    .filter((x): x is BubbleAction => x !== null);
}

/** 带本地化名称的完整工具列表 */
export function getAvailableTools(): ToolItem[] {
  return TOOL_DEFS.map(d => ({
    id: d.id,
    name: t(d.nameKey as any, d.nameParams),
    icon: d.icon,
    action: d.action,
  }));
}

/** 获取工具的分类 */
export function getToolCategory(id: string): ToolCategory | null {
  return TOOL_DEFS.find(d => d.id === id)?.category ?? null;
}

/** 保留向后兼容的静态导出（语言切换后 App.tsx 需手动刷新） */
export const AVAILABLE_TOOLS: ToolItem[] = getAvailableTools();
export const DEFAULT_TOOLS = getAvailableTools();

/** 从存储的 json 还原工具列表，重新应用当前语言的本地化名称 */
function localizeTool(stored: ToolItem): ToolItem {
  const def = TOOL_DEFS.find(d => d.id === stored.id);
  if (!def) return stored;
  return { ...stored, name: t(def.nameKey as any, def.nameParams), icon: def.icon, action: def.action };
}

// ── 模块级缓存 ──
let _configCache: ConfigData | null = null;
let _clipCache: ClipData | null = null;

/** 返回已缓存的配置（同步），未预热时返回 null */
export function getCachedConfig(): ConfigData | null { return _configCache; }

/** 返回已缓存的剪贴板状态（同步），未预热时返回 null */
export function getCachedClips(): ClipData | null { return _clipCache; }

/** 预热缓存，在进程启动时调用一次 */
export async function warmupCache(): Promise<void> {
  const [config, clips] = await Promise.all([loadConfig(), loadClips()]);
  _configCache = config;
  _clipCache = clips;
}

/** 加载唯一配置 */
export async function loadConfig(): Promise<ConfigData> {
  try {
    const json = await FloatingToolbar?.loadPreset(CONFIG_STORE_KEY);
    if (json) {
      const data = JSON.parse(json) as ConfigData;
      if (data.tools?.length) {
        const result = { tools: data.tools.map(localizeTool) };
        _configCache = result;
        return result;
      }
    }
  } catch (e) {
    console.warn('[ToolPresets]: loadConfig:', e);
  }
  // 默认返回前 8 个工具（4×2 布局）
  const result = { tools: getAvailableTools().slice(0, 8) };
  _configCache = result;
  return result;
}

/** 保存唯一配置（仅在工具数量合法时调用） */
export async function saveConfig(data: ConfigData): Promise<boolean> {
  try {
    _configCache = data;
    await FloatingToolbar?.savePreset(CONFIG_STORE_KEY, JSON.stringify(data));
    return true;
  } catch (e) {
    console.warn('[ToolPresets]: saveConfig:', e);
    return false;
  }
}

// ── 向后兼容别名（减少改动点）──
export async function loadPreset(_num?: number): Promise<ConfigData> {
  return loadConfig();
}
export async function savePreset(_num: number, data: ConfigData): Promise<boolean> {
  return saveConfig(data);
}

export async function loadClips(): Promise<ClipData> {
  try {
    const json = await FloatingToolbar?.loadPreset(CLIP_STORE_KEY);
    if (json) {
      const result = JSON.parse(json) as ClipData;
      _clipCache = result;
      return result;
    }
  } catch (e) {
    console.warn('[ToolPresets]: loadClips:', e);
  }
  const result = { '1': null, '2': null, '3': null, '4': null, '5': null, '6': null };
  _clipCache = result;
  return result;
}

export async function saveClips(clips: ClipData): Promise<void> {
  try {
    _clipCache = clips;
    await FloatingToolbar?.savePreset(CLIP_STORE_KEY, JSON.stringify(clips));
  } catch (e) {
    console.warn('[ToolPresets]: saveClips:', e);
  }
}

/** 注入剪贴板状态 + 当前模式高亮到工具列表 */
export function injectClipStatus(
  tools: ToolItem[],
  clips: ClipData,
  activeMode: 'nospacing' | 'paragraph' | null = null,
): ToolItem[] {
  return tools.map(tool => {
    if (tool.id.startsWith('clip_')) {
      const slot = tool.id.split('_')[1];
      const hasContent = !!clips[slot];
      return {
        ...tool,
        name: hasContent ? t('tool_clip_paste', { n: slot }) : t('tool_clip', { n: slot }),
        icon: hasContent ? `p${slot}` : `c${slot}`,
      };
    }
    void activeMode;
    return tool;
  });
}
