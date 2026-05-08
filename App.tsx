/**
 * App.tsx — Inkling 主面板（M0 占位 UI）
 *
 * 四屏路由：home → configure → progress → result
 * 数据流仍是假的：FilePickerBridge 返回固定路径，InklingCoreBridge 转换走
 * Kotlin 假定时器，发 4 个 stage 进度事件后 resolve 假 PDF 路径。
 *
 * 后续阶段保留这套骨架：M1 接 JNI 真转换，M0 之后再迭代视觉。
 */
import React, { useEffect, useState } from 'react';
import {
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import FilePickerBridge from './components/FilePickerBridge';
import InklingCoreBridge, { ProgressEvent, Stage } from './components/InklingCoreBridge';

type Screen = 'home' | 'configure' | 'progress' | 'result';

const STAGE_LABELS: Record<Stage, string> = {
  0: 'Parse',
  1: 'Layout',
  2: 'Render',
  3: 'Package',
  4: 'Done',
};

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [inputPath, setInputPath] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>(0);
  const [percent, setPercent] = useState(0);
  const [outputPath, setOutputPath] = useState<string | null>(null);

  useEffect(() => {
    const sub = InklingCoreBridge.onProgress((e: ProgressEvent) => {
      setStage(e.stage);
      setPercent(e.percent);
    });
    return () => sub.remove();
  }, []);

  const onPick = async () => {
    const path = await FilePickerBridge.pickDocument();
    setInputPath(path);
    setScreen('configure');
  };

  const onConvert = async () => {
    if (!inputPath) return;
    setStage(0);
    setPercent(0);
    setScreen('progress');
    const outPath = inputPath.replace(/\.[^.]+$/, '') + '.inkling.pdf';
    const jobId = String(Date.now());
    const result = await InklingCoreBridge.convert(inputPath, outPath, {}, jobId);
    setOutputPath(result);
    setScreen('result');
  };

  const onReset = () => {
    setScreen('home');
    setInputPath(null);
    setOutputPath(null);
    setStage(0);
    setPercent(0);
  };

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />
      <View style={styles.container}>
        <Text style={styles.title}>Inkling</Text>
        <Text style={styles.subtitle}>Document → bitmap PDF for Supernote</Text>

        {screen === 'home' && (
          <View style={styles.body}>
            <Pressable style={styles.primaryBtn} onPress={onPick}>
              <Text style={styles.primaryBtnText}>选择文档</Text>
            </Pressable>
          </View>
        )}

        {screen === 'configure' && (
          <View style={styles.body}>
            <Text style={styles.label}>输入文件</Text>
            <Text style={styles.path}>{inputPath}</Text>
            <View style={{ height: 24 }} />
            <Pressable style={styles.primaryBtn} onPress={onConvert}>
              <Text style={styles.primaryBtnText}>开始转换</Text>
            </Pressable>
            <Pressable style={styles.secondaryBtn} onPress={onReset}>
              <Text style={styles.secondaryBtnText}>取消</Text>
            </Pressable>
          </View>
        )}

        {screen === 'progress' && (
          <View style={styles.body}>
            <Text style={styles.label}>转换中</Text>
            <Text style={styles.stageText}>{STAGE_LABELS[stage]}</Text>
            <View style={styles.progressBar}>
              <View style={[styles.progressFill, { width: `${percent}%` }]} />
            </View>
            <Text style={styles.percent}>{percent}%</Text>
          </View>
        )}

        {screen === 'result' && (
          <View style={styles.body}>
            <Text style={styles.label}>已生成</Text>
            <Text style={styles.path}>{outputPath}</Text>
            <View style={{ height: 24 }} />
            <Pressable style={styles.primaryBtn} onPress={onReset}>
              <Text style={styles.primaryBtnText}>转换下一个</Text>
            </Pressable>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#FFFFFF' },
  container: { flex: 1, padding: 32 },
  title: { fontSize: 28, fontWeight: '700', color: '#111111' },
  subtitle: { fontSize: 14, color: '#888888', marginTop: 4, marginBottom: 32 },
  body: { flex: 1 },
  label: { fontSize: 14, color: '#888888', marginBottom: 8 },
  path: {
    fontSize: 14,
    color: '#111111',
    borderWidth: 1,
    borderColor: '#DDDDDD',
    padding: 12,
  },
  primaryBtn: {
    borderWidth: 1.5,
    borderColor: '#111111',
    backgroundColor: '#111111',
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: '#DDDDDD',
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  secondaryBtnText: { color: '#111111', fontSize: 16 },
  stageText: { fontSize: 24, color: '#111111', fontWeight: '600', marginBottom: 16 },
  progressBar: {
    height: 6,
    backgroundColor: '#DDDDDD',
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: '#111111' },
  percent: { fontSize: 14, color: '#888888', marginTop: 8 },
});
