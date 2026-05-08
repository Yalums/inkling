/**
 * Segmented — 二/三段选择器：黑底反白表示当前态，方角无圆角，仿 sticker
 * 视觉。用于"横排 / 竖排"、"竖向 / 横向半页"等枚举类配置。
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Borders, Colors, Type } from './theme';
import Touchable from './Touchable';

export interface SegmentOption<T extends string | number> {
  value: T;
  label: string;
}

interface Props<T extends string | number> {
  value: T;
  options: SegmentOption<T>[];
  onChange: (v: T) => void;
}

export function Segmented<T extends string | number>({
  value, options, onChange,
}: Props<T>) {
  return (
    <View style={styles.row}>
      {options.map((opt, i) => {
        const selected = opt.value === value;
        return (
          <Touchable key={String(opt.value)} onPress={() => onChange(opt.value)}>
            <View
              style={[
                styles.cell,
                selected && styles.cellOn,
                i > 0 && styles.cellLeftBorder,
              ]}>
              <Text style={[Type.body, selected && styles.textOn]}>
                {opt.label}
              </Text>
            </View>
          </Touchable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    borderWidth: Borders.default,
    borderColor: Colors.border,
  },
  cell: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: Colors.bg,
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellLeftBorder: { borderLeftWidth: Borders.default, borderLeftColor: Colors.border },
  cellOn: { backgroundColor: Colors.fg },
  textOn: { color: Colors.fgInverse, fontWeight: '600' },
});

export default Segmented;
