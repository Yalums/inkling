/**
 * TitleBar — 顶栏：左侧返回（可选）+ 居中标题 + 右侧动作（可选）。
 * 仿 sticker 的 TitleBar 视觉，但去掉了 a5/a5x2 多尺寸适配（Inkling 仅
 * 针对 10.65" / 7.8" 默认 dp 即可）。
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Borders, Colors, Spacing, TitleBarHeight, Type } from './theme';
import Touchable from './Touchable';

interface TitleBarProps {
  title: string;
  onBack?: () => void;
  rightLabel?: string;
  onRight?: () => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({ title, onBack, rightLabel, onRight }) => {
  return (
    <View style={styles.bar}>
      <View style={styles.side}>
        {onBack ? (
          <Touchable onPress={onBack}>
            <View style={styles.btn}>
              <Text style={styles.btnText}>←</Text>
            </View>
          </Touchable>
        ) : null}
      </View>
      <Text style={[Type.heading, styles.title]} numberOfLines={1}>
        {title}
      </Text>
      <View style={[styles.side, { alignItems: 'flex-end' }]}>
        {rightLabel ? (
          <Touchable onPress={onRight}>
            <View style={styles.btn}>
              <Text style={styles.btnText}>{rightLabel}</Text>
            </View>
          </Touchable>
        ) : null}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  bar: {
    height: TitleBarHeight,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.bg,
    borderBottomWidth: Borders.thick,
    borderBottomColor: Colors.border,
    paddingHorizontal: Spacing.lg,
  },
  side: { width: 80, justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center' },
  btn: { paddingVertical: Spacing.sm, paddingHorizontal: Spacing.sm },
  btnText: { ...Type.body, fontWeight: '600' },
});

export default TitleBar;
