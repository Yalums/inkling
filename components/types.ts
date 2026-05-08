/**
 * types.ts — App 内共享的转换配置类型 + 默认值。
 * 字段名 / 序列化与 cpp/inkling/options.{h,cpp} 的 parseOptions 对齐。
 */

export type OrientationKind = 'horizontal' | 'vertical';

export interface ConvertOptions {
  fontPath: string;
  orientation: OrientationKind;
  pageWidth: number;
  pageHeight: number;
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
  fontSize: number;
  lineHeightMul: number;
  paragraphSpacing: number;
  splitLandscape: boolean;
  jpegQuality: number;
  threadCount: number;
  embedTextLayer: boolean;
  embedBookmarks: boolean;
}

// Best-effort default font path on stock Android (Supernote firmware ships a
// Noto CJK ttc here). Override in AdvancedScreen if the device differs.
export const DEFAULT_FONT_PATH = '/system/fonts/NotoSansCJK-Regular.ttc';

export const defaultOptions: ConvertOptions = {
  fontPath: DEFAULT_FONT_PATH,
  orientation: 'horizontal',
  pageWidth: 1920,
  pageHeight: 2560,
  marginTop: 80,
  marginRight: 80,
  marginBottom: 80,
  marginLeft: 80,
  fontSize: 22,
  lineHeightMul: 1.6,
  paragraphSpacing: 6,
  splitLandscape: false,
  jpegQuality: 90,
  threadCount: 0,
  embedTextLayer: true,
  embedBookmarks: true,
};

export function toOptionsJson(o: ConvertOptions): Record<string, unknown> {
  return {
    fontPath:         o.fontPath,
    orientation:      o.orientation === 'vertical' ? 'vertical-rtl' : 'horizontal',
    pageWidth:        o.pageWidth,
    pageHeight:       o.pageHeight,
    marginTop:        o.marginTop,
    marginRight:      o.marginRight,
    marginBottom:     o.marginBottom,
    marginLeft:       o.marginLeft,
    fontSize:         o.fontSize,
    lineHeightMul:    o.lineHeightMul,
    paragraphSpacing: o.paragraphSpacing,
    splitLandscape:   o.splitLandscape,
    jpegQuality:      o.jpegQuality,
    threadCount:      o.threadCount,
    embedTextLayer:   o.embedTextLayer,
    embedBookmarks:   o.embedBookmarks,
  };
}
