import { PluginCommAPI, PluginFileAPI, PluginNoteAPI, PluginManager } from 'sn-plugin-lib';
import { NativeModules } from 'react-native';
import RNFS from 'react-native-fs';
import { loadClips, saveClips } from './ToolPresets';
import { toggleMode, handleAiSend } from './BackgroundService';

const { FloatingToolbar } = NativeModules;

let _filePath: string | null = null;
let _pageNum: number | null = null;

/** Sticker 目录：必须是 Supernote 内置的 MyStyle/Sticker，
 *  saveStickerByLasso 的 SDK 实现对路径有隐式要求——写到其他白名单目录（如 EXPORT）
 *  时内部拿不到 NoteOperateTrails → NPE。参考版亲测此路径可用。 */
const STICKER_DIR = '/sdcard/MyStyle/Sticker';

async function ensureStickerDir(): Promise<void> {
  try {
    const exists = await RNFS.exists(STICKER_DIR);
    if (!exists) await RNFS.mkdir(STICKER_DIR);
  } catch (e) {
    console.warn('[ToolActions]: ensureStickerDir failed:', e);
  }
}

/** 特殊返回值：App.tsx 检测到后路由到对应屏幕 */
export const OPEN_IMAGE_PICKER = '__open_image_picker__';
export const OPEN_SEND_SCREEN = '__open_send_screen__';

async function ctx(): Promise<boolean> {
  try {
    const fp = await PluginCommAPI.getCurrentFilePath();
    if (fp.success && fp.result) _filePath = fp.result;
    const pg = await PluginCommAPI.getCurrentPageNum();
    if (pg.success && pg.result !== undefined) _pageNum = pg.result;
    return !!_filePath && _pageNum !== null;
  } catch { return false; }
}

export async function executeAction(action: string): Promise<string> {
  console.log('[ToolActions]:', action);

  // ── 文本接收模式（tap-once 切换，不需要文件上下文） ──
  if (action === 'text_recv_nospacing') {
    const mode = await toggleMode('nospacing');
    return mode === 'nospacing' ? 'Text receive: no-gap ON' : 'Text receive OFF';
  }
  if (action === 'text_recv_paragraph') {
    const mode = await toggleMode('paragraph');
    return mode === 'paragraph' ? 'Text receive: paragraph ON' : 'Text receive OFF';
  }

  // ── 套索 → 发送到 LocalSend 设备（由 App.tsx 接管） ──
  if (action === 'lasso_send') {
    return OPEN_SEND_SCREEN;
  }

  // ── 套索 → 发给 AI（后台异步，立刻返回） ──
  if (action === 'lasso_ai') {
    handleAiSend().catch(e => console.error('[ToolActions]: lasso_ai error:', e));
    return 'Sending to AI...';
  }

  // ── 区域截图 → 发给 AI（占位，功能未实现） ──
  if (action === 'screenshot_ai') {
    console.log('[ToolActions]: screenshot_ai — placeholder');
    return 'Screenshot AI: coming soon';
  }

  // ── 插入图片（由 App.tsx 接管） ──
  if (action === 'insert_image') {
    return OPEN_IMAGE_PICKER;
  }

  if (action === 'insert_doc_screenshot') {
    // Handled natively by NativeScreenshotPanel — this is a fallback
    return 'Handled by native panel';
  }

  // ── 下面是需要文件上下文的动作 ──
  if (!action.startsWith('clip_save_')) {
    if (!await ctx()) return 'No file context';
  }

  try {
    if (action === 'layer_prev') {
      await PluginNoteAPI.saveCurrentNote();
      return await layerPrev();
    }
    if (action === 'layer_next') {
      await PluginNoteAPI.saveCurrentNote();
      return await layerNext();
    }

    if (action.startsWith('clip_paste_')) {
      const slot = action.charAt(action.length - 1);
      return await clipSmartAction(slot);
    }
    if (action.startsWith('clip_save_')) {
      const slot = action.charAt(action.length - 1);
      return await clipSave(slot);
    }
    if (action.startsWith('clip_clear_')) {
      const slot = action.charAt(action.length - 1);
      return await clipClear(slot);
    }

    return `Unknown: ${action}`;
  } catch (e) {
    console.error('[ToolActions]:', e);
    return `Error: ${String(e)}`;
  }
}

// ── 图层切换 ──

async function layerPrev(): Promise<string> {
  if (!_filePath || _pageNum === null) return 'No context';
  const lr = await PluginFileAPI.getLayers(_filePath, _pageNum);
  if (!lr.success || !lr.result) return 'Get layers failed';

  const allLayers = lr.result.map((l: any) => ({
    ...l,
    id: l.layerId !== undefined ? l.layerId : l.layerNum
  })).sort((a: any, b: any) => a.id - b.id);

  const current = allLayers.find((l: any) => l.isCurrentLayer) || allLayers[allLayers.length - 1];
  const currentId = current.id;

  const above = allLayers.filter((l: any) => l.id > currentId);
  if (above.length > 0) {
    const target = above[0];
    const updated = allLayers
      .filter((l: any) => l.id >= 0)
      .map((l: any) => ({
        layerId: l.id,
        name: l.name,
        isVisible: l.isVisible,
        isCurrentLayer: l.id === target.id
      }));
    const r = await PluginFileAPI.modifyLayers(_filePath, _pageNum, updated);
    if (r.success) { await PluginCommAPI.reloadFile(); return `Layer ${target.id}`; }
    return 'Switch failed';
  }

  const userLayers = allLayers.filter((l: any) => l.id >= 0);
  const maxUserId = userLayers.length > 0 ? Math.max(...userLayers.map((l: any) => l.id)) : -1;
  if (maxUserId >= 3) return 'Max 4 user layers';

  const newId = maxUserId + 1;
  const ir = await PluginFileAPI.insertLayer(_filePath, _pageNum, {
    layerId: newId,
    name: `Layer ${newId + 1}`,
    isVisible: true,
    isCurrentLayer: true,
  });

  if (ir.success) {
    await PluginCommAPI.reloadFile();
    return `New layer ${newId}`;
  }
  return 'Create layer failed';
}

async function layerNext(): Promise<string> {
  if (!_filePath || _pageNum === null) return 'No context';
  const lr = await PluginFileAPI.getLayers(_filePath, _pageNum);
  if (!lr.success || !lr.result) return 'Get layers failed';

  const allLayers = lr.result.map((l: any) => ({
    ...l,
    id: l.layerId !== undefined ? l.layerId : l.layerNum
  })).sort((a: any, b: any) => a.id - b.id);

  const current = allLayers.find((l: any) => l.isCurrentLayer) || allLayers[allLayers.length - 1];
  const currentId = current.id;

  const below = allLayers.filter((l: any) => l.id < currentId).sort((a: any, b: any) => b.id - a.id);
  if (below.length === 0) return 'Already at bottom layer';

  const target = below[0];
  const updated = allLayers
    .filter((l: any) => l.id >= 0)
    .map((l: any) => ({
      layerId: l.id,
      name: l.name,
      isVisible: l.isVisible,
      isCurrentLayer: l.id === target.id
    }));
  const r = await PluginFileAPI.modifyLayers(_filePath, _pageNum, updated);
  if (r.success) { await PluginCommAPI.reloadFile(); return `Layer ${target.id}`; }
  return 'Switch failed';
}

// ── 剪贴板操作 ──

async function clipSmartAction(slot: string): Promise<string> {
  try {
    const lassoRes = await PluginCommAPI.getLassoRect();
    const hasLasso = lassoRes.success && lassoRes.result != null;
    if (hasLasso) {
      return await clipSave(slot);
    }
  } catch {}
  return await clipPasteSticker(slot);
}

async function clipSave(slot: string): Promise<string> {
  await ensureStickerDir();
  const name = `quickbar_clip_${slot}_${Date.now()}.sticker`;
  const path = `${STICKER_DIR}/${name}`;

  console.log('[ToolActions]: clipSave slot=', slot, 'path=', path);

  // 优先用 saveStickerByLasso：使用套索框尺寸作为 sticker 画布，粘贴大小正确。
  // 必须写到 MyStyle/Sticker，写其他目录内部拿不到 NoteOperateTrails → NPE。
  const saveRes = await PluginCommAPI.saveStickerByLasso(path);
  if (saveRes.success) {
    console.log('[ToolActions]: saveStickerByLasso ok');
    await PluginCommAPI.setLassoBoxState(2);
    const clips = await loadClips();
    clips[slot] = path;
    await saveClips(clips);
    return `Saved to clip ${slot}`;
  }

  // 回退：getLassoElements → convertElement2Sticker
  // 缺点：sticker 画布按元素包围盒裁剪，粘贴时偏小。
  console.warn('[ToolActions]: saveStickerByLasso failed, fallback to convertElement2Sticker:', saveRes);

  const elemRes = await PluginCommAPI.getLassoElements() as any;
  if (!elemRes?.success || !elemRes.result || !Array.isArray(elemRes.result) || elemRes.result.length === 0) {
    console.warn('[ToolActions]: getLassoElements failed or empty:', elemRes);
    return `Save clip ${slot} failed (no elements)`;
  }

  // convertElement2Sticker native 侧只接受 penType 1/10/11，
  // 其他值（0=默认, 2=书写笔, 等）报 "Invalid pen type" (code 302)。
  // 非白名单一律映射为 1（pressure pen）。
  const VALID_PEN_TYPES = new Set([1, 10, 11]);
  const fixedElements = (elemRes.result as any[]).map((el: any) => {
    if (el?.stroke != null && !VALID_PEN_TYPES.has(el.stroke.penType)) {
      return { ...el, stroke: { ...el.stroke, penType: 1 } };
    }
    return el;
  });

  const deviceType = await PluginManager.getDeviceType();
  const convertRes = await PluginCommAPI.convertElement2Sticker({
    machineType: deviceType,
    elements: fixedElements,
    stickerPath: path,
  });
  if (!convertRes.success) {
    console.warn('[ToolActions]: convertElement2Sticker failed:', convertRes);
    return `Save clip ${slot} failed`;
  }

  await PluginCommAPI.setLassoBoxState(2);

  const clips = await loadClips();
  clips[slot] = path;
  await saveClips(clips);
  return `Saved to clip ${slot}`;
}

async function clipPasteSticker(slot: string): Promise<string> {
  const clips = await loadClips();
  const stored = clips[slot];
  if (!stored) return 'Clip empty';

  // 判断存储的是完整路径还是旧版文件名
  let paths: string[];
  if (stored.startsWith('/')) {
    // 新格式：完整路径
    paths = [stored];
  } else {
    // 旧格式：只有文件名，拼 STICKER_DIR
    paths = [`${STICKER_DIR}/${stored}`];
  }

  for (const path of paths) {
    try {
      const r = await PluginCommAPI.insertSticker(path);
      if (r.success) return `Pasted clip ${slot}`;
    } catch {}
    // 也试 .sticker 后缀追加（旧版兼容）
    try {
      const r2 = await PluginCommAPI.insertSticker(path + '.sticker');
      if (r2.success) return `Pasted clip ${slot}`;
    } catch {}
  }

  return `Paste clip ${slot} failed`;
}

async function clipClear(slot: string): Promise<string> {
  const clips = await loadClips();
  clips[slot] = null;
  await saveClips(clips);
  return `Clip ${slot} cleared`;
}
