/**
 * Card — 框线容器，承载分组（如"输入文件"、"页面尺寸"）。
 * 配合可选 label（左上小字）+ children 内容区。
 */
import React from 'react';
import { StyleSheet, Text, View, ViewStyle } from 'react-native';

import { Borders, Colors, Spacing, Type } from './theme';

interface CardProps {
  label?: string;
  style?: ViewStyle;
  children: React.ReactNode;
}

export const Card: React.FC<CardProps> = ({ label, style, children }) => {
  return (
    <View style={[styles.wrap, style]}>
      {label ? <Text style={[Type.small, styles.label]}>{label}</Text> : null}
      <View style={styles.body}>{children}</View>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { marginBottom: Spacing.lg },
  label: { marginBottom: Spacing.xs, letterSpacing: 0.5, textTransform: 'uppercase' },
  body: {
    borderWidth: Borders.default,
    borderColor: Colors.border,
    backgroundColor: Colors.bg,
    padding: Spacing.md,
  },
});

export default Card;
