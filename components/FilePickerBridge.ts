/**
 * FilePickerBridge — JS wrapper around native FilePicker module.
 *
 * pickDocument() opens the SAF document picker and resolves with an absolute
 * path inside the plugin's sandbox (the native side copies the chosen URI's
 * content into a sandbox file before resolving).
 */
import { NativeModules } from 'react-native';

const { FilePicker } = NativeModules;

export function pickDocument(): Promise<string> {
  return FilePicker.pickDocument();
}

export default { pickDocument };
