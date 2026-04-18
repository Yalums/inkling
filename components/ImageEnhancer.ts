import { NativeModules } from 'react-native';

const { ImageEnhancerModule } = NativeModules;

export interface EnhanceOptions {
  gamma: number;       // e.g. 1.3
  contrast: number;    // e.g. 1.35
  brightness: number;  // e.g. -70
  sharpen: number;     // e.g. 1.0
  bgNorm: boolean;     // shadow removal on/off
  bgBlur: number;      // blur radius for shadow removal, e.g. 55
}

/** Default parameters tuned for document scanning on e-ink */
export const ENHANCE_DEFAULTS: EnhanceOptions = {
  gamma: 1.3,
  contrast: 1.35,
  brightness: -70,
  sharpen: 1.0,
  bgNorm: true,
  bgBlur: 55,
};

/**
 * Enhance an image for document readability.
 * @param inputPath absolute file path (no file:// prefix)
 * @param options   enhancement parameters (defaults to ENHANCE_DEFAULTS)
 * @returns absolute path to enhanced PNG
 */
export async function enhanceImage(
  inputPath: string,
  options: Partial<EnhanceOptions> = {},
): Promise<string> {
  const opts = { ...ENHANCE_DEFAULTS, ...options };
  return ImageEnhancerModule.enhance(inputPath, opts);
}
