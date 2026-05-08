/**
 * OrientationBridge — locks the host activity orientation.
 *
 * Default Inkling flow is portrait; the AdvancedScreen calls lockLandscape()
 * on mount and lockPortrait() on unmount.
 */
import { NativeModules } from 'react-native';

const { Orientation } = NativeModules;

export function lockPortrait(): Promise<boolean> {
  return Orientation.lockPortrait();
}

export function lockLandscape(): Promise<boolean> {
  return Orientation.lockLandscape();
}

export function unlock(): Promise<boolean> {
  return Orientation.unlock();
}

export default { lockPortrait, lockLandscape, unlock };
