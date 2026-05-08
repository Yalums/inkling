/**
 * SwitchRow — 一行布尔开关：左侧标签，右侧 [ON]/[OFF]，方框文字风格。
 * 不用 RN 的 Switch（动画 + 颜色，墨水屏不友好）。
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Borders, Colors, Spacing, Type } from './theme';
import Touchable from './Touchable';

interface Props {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}

export const SwitchRow: React.FC<Props> = ({ label, value, onChange }) => {
  return (
    <Touchable onPress={() => onChange(!value)}>
      <View style={styles.row}>
        <Text style={[Type.body, styles.label]}>{label}</Text>
        <View style={[styles.box, value ? styles.boxOn : styles.boxOff]}>
          <Text style={[styles.boxText, value && styles.boxTextOn]}>
            {value ? 'ON' : 'OFF'}
          </Text>
        </View>
      </View>
    </Touchable>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.sm,
  },
  label: { flex: 1, marginRight: Spacing.md },
  box: {
    minWidth: 56,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderWidth: Borders.default,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn:  { backgroundColor: Colors.fg },
  boxOff: { backgroundColor: Colors.bg },
  boxText: { ...Type.small, color: Colors.fg, fontWeight: '700' },
  boxTextOn: { color: Colors.fgInverse },
});

export default SwitchRow;
