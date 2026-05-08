/**
 * NumberInput — 整数/浮点输入框，黑边方角，数值居右；内含 -/+ 按钮做
 * 步进。用于 advanced 设置里的 px/质量/线程数等。
 */
import React from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { Borders, Colors, Spacing, Type } from './theme';
import Touchable from './Touchable';

interface Props {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  decimals?: number;
}

export const NumberInput: React.FC<Props> = ({
  label, value, onChange, step = 1, min, max, decimals = 0,
}) => {
  const clamp = (v: number) => {
    if (min !== undefined && v < min) v = min;
    if (max !== undefined && v > max) v = max;
    return v;
  };
  const fmt = (v: number) => decimals > 0 ? v.toFixed(decimals) : String(Math.round(v));
  return (
    <View style={styles.row}>
      <Text style={[Type.body, styles.label]}>{label}</Text>
      <View style={styles.controls}>
        <Touchable onPress={() => onChange(clamp(value - step))}>
          <View style={styles.stepBtn}>
            <Text style={Type.body}>-</Text>
          </View>
        </Touchable>
        <TextInput
          style={styles.input}
          value={fmt(value)}
          keyboardType="numeric"
          onChangeText={txt => {
            const n = decimals > 0 ? parseFloat(txt) : parseInt(txt, 10);
            if (!Number.isNaN(n)) onChange(clamp(n));
          }}
        />
        <Touchable onPress={() => onChange(clamp(value + step))}>
          <View style={styles.stepBtn}>
            <Text style={Type.body}>+</Text>
          </View>
        </Touchable>
      </View>
    </View>
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
  controls: { flexDirection: 'row', alignItems: 'center' },
  stepBtn: {
    width: 36,
    height: 36,
    borderWidth: Borders.default,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.bg,
  },
  input: {
    minWidth: 80,
    height: 36,
    borderTopWidth: Borders.default,
    borderBottomWidth: Borders.default,
    borderColor: Colors.border,
    paddingHorizontal: 8,
    textAlign: 'center',
    color: Colors.fg,
    fontSize: 16,
    paddingVertical: 0,
  },
});

export default NumberInput;
