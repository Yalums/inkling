import { PluginCommAPI } from 'sn-plugin-lib';
import { FileLogger } from './FileLogger';

export interface ExtractedContent {
  text: string;
  imagePaths: string[];
  /**
   * 套索选区中 Y 坐标最大（最靠下）的文本框矩形，像素坐标。
   * 用于 AI 回复定位：在此框 bottom 下方开始插入回复。
   */
  lastTextBoxRect?: { left: number; top: number; right: number; bottom: number };
  stats: {
    strokes: number;
    textBoxes: number;
    pictures: number;
    others: number;
    recognizedStrokes: number;
  };
}

export class LassoExtractor {
  /**
   * 从当前套索选区中提取所有可发送内容。
   *
   * 提取策略：
   *   - TextBox (500/501/502)：直接取 textContentFull
   *   - Stroke (0)：取 recognizeResult（SDK 自带手写识别）—— TODO: 后续可替换外部 OCR
   *   - Picture (200)：取 picture.path
   *   - 其他类型：跳过
   */
  static async extract(): Promise<ExtractedContent> {
    const result: ExtractedContent = {
      text: '',
      imagePaths: [],
      stats: { strokes: 0, textBoxes: 0, pictures: 0, others: 0, recognizedStrokes: 0 },
    };

    const res = await PluginCommAPI.getLassoElements() as any;
    if (!res?.success || !Array.isArray(res.result)) {
      FileLogger.logEvent('LassoExtract', `getLassoElements failed: ${res?.error?.message ?? 'unknown'}`);
      return result;
    }

    const elements = res.result;
    FileLogger.logEvent('LassoExtract', `found ${elements.length} elements`);

    type SortableItem = {
      sortY: number;
      text?: string;
      imagePath?: string;
      rect?: { left: number; top: number; right: number; bottom: number };
    };
    const sortable: SortableItem[] = [];

    for (const el of elements) {
      try {
        switch (el.type) {
          case 500:
          case 501:
          case 502: {
            result.stats.textBoxes++;
            const content = el.textBox?.textContentFull ?? '';
            const rect = el.textBox?.textRect as
              | { left: number; top: number; right: number; bottom: number }
              | undefined;
            if (content.trim()) {
              sortable.push({ sortY: rect?.top ?? 0, text: content.trim(), rect });
            }
            break;
          }

          case 0: {
            result.stats.strokes++;
            const recognized = extractRecognizedText(el);
            if (recognized) {
              result.stats.recognizedStrokes++;
              let sortY = 0;
              try {
                const cSize = await el.contoursSrc?.size?.();
                if (cSize && cSize > 0) {
                  const firstContour = await el.contoursSrc.get(0);
                  if (Array.isArray(firstContour) && firstContour.length > 0) {
                    sortY = firstContour[0].y ?? 0;
                  }
                }
              } catch (_) {}
              sortable.push({ sortY, text: recognized });
            }
            break;
          }

          case 200: {
            result.stats.pictures++;
            const imgPath = el.picture?.path;
            if (imgPath) {
              sortable.push({ sortY: 0, imagePath: imgPath });
              result.imagePaths.push(imgPath);
            }
            break;
          }

          default:
            result.stats.others++;
            break;
        }
      } catch (e) {
        console.warn('[LassoExtractor]: error processing element', el.type, e);
      }
    }

    sortable.sort((a, b) => a.sortY - b.sortY);

    const textParts: string[] = [];
    for (const item of sortable) {
      if (item.text) textParts.push(item.text);
    }
    result.text = textParts.join('\n');

    // 找出 bottom 最大（最靠下）的文本框，作为 AI 回复起始定位参考
    for (const item of sortable) {
      if (item.rect && typeof item.rect.bottom === 'number') {
        if (!result.lastTextBoxRect || item.rect.bottom > result.lastTextBoxRect.bottom) {
          result.lastTextBoxRect = item.rect;
        }
      }
    }

    for (const el of elements) {
      // fire-and-forget：不 await recycle()。
      // closePluginView 后 recycle() 的 Promise 可能永久 pending（不 resolve 也不 reject），
      // await 会让整个 extract() 挂死，后续 sendQuery/showAiBubble 全部不执行。
      try { el.recycle?.(); } catch (_) {}
    }

    FileLogger.logEvent('LassoExtract',
      `extracted: text=${result.text.length}chars images=${result.imagePaths.length} stats=${JSON.stringify(result.stats)}`);
    return result;
  }
}

function extractRecognizedText(element: any): string | null {
  const recogData = element.recognizeResult?.data;
  if (!recogData || !Array.isArray(recogData) || recogData.length === 0) return null;
  let best = recogData[0];
  for (const candidate of recogData) {
    if (candidate.score > best.score) best = candidate;
  }
  return best.text?.trim() || null;
}
