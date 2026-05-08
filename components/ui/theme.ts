/**
 * theme.ts — Inkling 视觉常量
 *
 * 风格沿用 sticker demo 的语言：纯黑 #000 边框、纯白背景、点状分隔线、
 * 方角；CLAUDE.md 的灰阶 #DDD/#888 用于次级文字和分隔。
 *
 * 所有数值是 dp（不是 px），sticker 那套 dp_px_N 我们这里不再借入——
 * 直接使用 dp 让屏幕尺寸读起来直观。
 */

export const Colors = {
  bg:           '#FFFFFF',
  fg:           '#111111',
  fgInverse:    '#FFFFFF',
  border:       '#000000',
  borderSoft:   '#DDDDDD',
  textMuted:    '#888888',
  highlight:    '#000000',
};

export const Borders = {
  hairline: 1,
  default:  1.5,
  thick:    2,
};

export const Spacing = {
  xs:  4,
  sm:  8,
  md:  16,
  lg:  24,
  xl:  32,
  xxl: 48,
};

export const Type = {
  display: { fontSize: 32, fontWeight: '700' as const, color: Colors.fg },
  title:   { fontSize: 24, fontWeight: '700' as const, color: Colors.fg },
  heading: { fontSize: 18, fontWeight: '600' as const, color: Colors.fg },
  body:    { fontSize: 16, fontWeight: '400' as const, color: Colors.fg },
  small:   { fontSize: 13, fontWeight: '400' as const, color: Colors.textMuted },
  mono:    { fontSize: 14, fontFamily: 'monospace' as const, color: Colors.fg },
};

export const TitleBarHeight = 56;
