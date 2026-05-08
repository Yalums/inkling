/**
 * App.tsx — Inkling 主面板路由器
 *
 * Screen 流转：
 *   home → configure → (advanced ⇄ configure) → progress → result → home
 *
 * 默认竖屏；只有 advanced 屏 mount 时通过 OrientationBridge.lockLandscape()
 * 自动切横屏，离开时回 portrait。其他屏的 orientation 维持设备默认。
 */
import React, { useEffect, useState } from 'react';
import { SafeAreaView, StatusBar, StyleSheet } from 'react-native';

import FilePickerBridge from './components/FilePickerBridge';
import InklingCoreBridge, { ProgressEvent } from './components/InklingCoreBridge';
import { ConvertOptions, defaultOptions, toOptionsJson } from './components/types';
import AdvancedScreen   from './components/screens/AdvancedScreen';
import ConfigureScreen  from './components/screens/ConfigureScreen';
import HomeScreen       from './components/screens/HomeScreen';
import ProgressScreen   from './components/screens/ProgressScreen';
import ResultScreen     from './components/screens/ResultScreen';
import { Colors } from './components/ui/theme';

type Screen = 'home' | 'configure' | 'advanced' | 'progress' | 'result';

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [inputPath, setInputPath] = useState<string | null>(null);
  const [options, setOptions] = useState<ConvertOptions>(defaultOptions);

  const [stage, setStage] = useState(0);
  const [percent, setPercent] = useState(0);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const sub = InklingCoreBridge.onProgress((e: ProgressEvent) => {
      setStage(e.stage);
      setPercent(e.percent);
    });
    return () => sub.remove();
  }, []);

  const reset = () => {
    setScreen('home');
    setInputPath(null);
    setOutputPath(null);
    setError(null);
    setStage(0);
    setPercent(0);
  };

  const onPick = async () => {
    try {
      const path = await FilePickerBridge.pickDocument();
      if (!path) return;
      setInputPath(path);
      setScreen('configure');
    } catch (e: unknown) {
      // Picker cancelled or denied; stay on current screen.
      console.warn('[App] pick failed:', e);
    }
  };

  const onConvert = async () => {
    if (!inputPath) return;
    setStage(0);
    setPercent(0);
    setError(null);
    setOutputPath(null);
    setScreen('progress');

    const out = inputPath.replace(/\.[^.]+$/, '') + '.inkling.pdf';
    const jobId = String(Date.now());
    try {
      const result = await InklingCoreBridge.convert(
        inputPath, out, toOptionsJson(options), jobId);
      setOutputPath(result);
      setScreen('result');
    } catch (e: any) {
      setError(typeof e === 'object' && e?.message ? e.message : String(e));
      setScreen('result');
    }
  };

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor={Colors.bg} />
      {screen === 'home' && (
        <HomeScreen onPick={onPick} />
      )}
      {screen === 'configure' && inputPath && (
        <ConfigureScreen
          inputPath={inputPath}
          options={options}
          onOptionsChange={setOptions}
          onPickAgain={onPick}
          onAdvanced={() => setScreen('advanced')}
          onConvert={onConvert}
          onBack={reset}
        />
      )}
      {screen === 'advanced' && (
        <AdvancedScreen
          options={options}
          onOptionsChange={setOptions}
          onApply={() => setScreen('configure')}
        />
      )}
      {screen === 'progress' && (
        <ProgressScreen stage={stage} percent={percent} />
      )}
      {screen === 'result' && (
        <ResultScreen
          ok={!error}
          outputPath={outputPath}
          errorMessage={error}
          onAgain={reset}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
});
