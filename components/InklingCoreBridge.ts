/**
 * InklingCoreBridge — JS wrapper around native InklingCore module.
 *
 * convert() resolves with the output PDF path; progress events are delivered
 * via DeviceEventEmitter on the 'InklingProgress' channel.
 */
import { NativeModules, DeviceEventEmitter, EmitterSubscription } from 'react-native';

const { InklingCore } = NativeModules;

export type Stage = 0 | 1 | 2 | 3 | 4; // parse / layout / render / package / done

export interface ProgressEvent {
  jobId: string;
  stage: Stage;
  percent: number;
}

export interface ConvertOptions {
  /** Future: orientation, font size, dpi, etc. Serialized to JSON for native. */
  [key: string]: unknown;
}

export function convert(
  inputPath: string,
  outputPath: string,
  options: ConvertOptions,
  jobId: string,
): Promise<string> {
  return InklingCore.convert(inputPath, outputPath, JSON.stringify(options), jobId);
}

export function onProgress(cb: (e: ProgressEvent) => void): EmitterSubscription {
  return DeviceEventEmitter.addListener('InklingProgress', cb);
}

/** Returns the native libinkling_jni.so version string (sanity check for JNI link). */
export function nativeVersion(): Promise<string> {
  return InklingCore.nativeVersion();
}

export default { convert, onProgress, nativeVersion };
