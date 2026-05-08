/**
 * Button — 三种变体：primary（黑底白字）、secondary（白底黑边黑字）、
 * ghost（仅文字，下划线，用于次级动作和"高级设置"链接）。
 */
import React from 'react';
import { StyleSheet, Text, TextStyle, View, ViewStyle } from 'react-native';

import { Borders, Colors, Spacing, Type } from './theme';
import Touchable from './Touchable';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  style?: ViewStyle;
  textStyle?: TextStyle;
}

export const Button: React.FC<ButtonProps> = ({
  label, onPress, variant = 'primary', disabled, style, textStyle,
}) => {
  const v = variantStyles[variant];
  const handler = disabled ? undefined : onPress;
  return (
    <Touchable onPress={handler}>
      <View style={[styles.base, v.body, disabled && styles.disabled, style]}>
        <Text style={[styles.text, v.text, textStyle]}>{label}</Text>
      </View>
    </Touchable>
  );
};

const styles = StyleSheet.create({
  base: {
    minHeight: 48,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm + 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { ...Type.body, fontWeight: '600' },
  disabled: { opacity: 0.4 },
});

const variantStyles: Record<ButtonVariant, { body: ViewStyle; text: TextStyle }> = {
  primary: {
    body: {
      backgroundColor: Colors.fg,
      borderWidth: Borders.thick,
      borderColor: Colors.border,
    },
    text: { color: Colors.fgInverse },
  },
  secondary: {
    body: {
      backgroundColor: Colors.bg,
      borderWidth: Borders.thick,
      borderColor: Colors.border,
    },
    text: { color: Colors.fg },
  },
  ghost: {
    body: {
      backgroundColor: 'transparent',
    },
    text: { color: Colors.fg, textDecorationLine: 'underline' },
  },
};

export default Button;
