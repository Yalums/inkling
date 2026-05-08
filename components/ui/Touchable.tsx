/**
 * Touchable — sticker demo 同款：用 PanResponder 包 TouchableWithoutFeedback。
 * e-ink 触摸响应在 native 端有自己的 ripple 处理；JS 不做任何视觉反馈，避免
 * 引入墨水屏不友好的动画。
 */
import React, { useRef } from 'react';
import { PanResponder, TouchableWithoutFeedback, ViewProps } from 'react-native';

interface TouchableProps extends ViewProps {
  onPress?: () => void;
  children: React.ReactNode;
}

export const Touchable: React.FC<TouchableProps> = ({ onPress, children, ...rest }) => {
  const start = useRef(0);
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        start.current = Date.now();
      },
      onPanResponderRelease: () => {
        const dur = Date.now() - start.current;
        if (dur >= 0) onPress?.();
      },
    }),
  ).current;

  return (
    <TouchableWithoutFeedback {...rest} {...responder.panHandlers}>
      {children}
    </TouchableWithoutFeedback>
  );
};

export default Touchable;
