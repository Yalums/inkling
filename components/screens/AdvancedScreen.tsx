/**
 * AdvancedScreen — 横屏布局（mount 时锁定 landscape，卸载时还回 portrait）。
 * 三栏式参数表：左/中/右各一组（版面 / 渲染 / 输出），顶部 TitleBar 上有 Apply。
 */
import React, { useEffect } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import Card from '../ui/Card';
import NumberInput from '../ui/NumberInput';
import SwitchRow from '../ui/SwitchRow';
import TitleBar from '../ui/TitleBar';
import { Colors, Spacing } from '../ui/theme';
import { t } from '../i18n';
import { lockLandscape, lockPortrait } from '../OrientationBridge';
import { ConvertOptions } from '../types';

interface Props {
  options: ConvertOptions;
  onOptionsChange: (next: ConvertOptions) => void;
  onApply: () => void;
}

export const AdvancedScreen: React.FC<Props> = ({ options, onOptionsChange, onApply }) => {
  useEffect(() => {
    lockLandscape().catch(() => {});
    return () => {
      lockPortrait().catch(() => {});
    };
  }, []);

  const update = <K extends keyof ConvertOptions>(k: K, v: ConvertOptions[K]) =>
    onOptionsChange({ ...options, [k]: v });

  return (
    <View style={styles.root}>
      <TitleBar
        title={t('adv_title')}
        onBack={onApply}
        rightLabel={t('adv_apply')}
        onRight={onApply}
      />
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.columns}>

          <View style={styles.col}>
            <Card label={t('adv_section_layout')}>
              <NumberInput
                label={t('adv_page_width')}
                value={options.pageWidth}
                onChange={v => update('pageWidth', v)}
                min={400}
                max={4096}
                step={20}
              />
              <NumberInput
                label={t('adv_page_height')}
                value={options.pageHeight}
                onChange={v => update('pageHeight', v)}
                min={400}
                max={4096}
                step={20}
              />
              <NumberInput
                label={t('adv_margin')}
                value={options.marginTop}
                onChange={v => onOptionsChange({
                  ...options,
                  marginTop: v, marginRight: v, marginBottom: v, marginLeft: v,
                })}
                min={0}
                max={400}
                step={4}
              />
              <SwitchRow
                label={t('adv_split_landscape')}
                value={options.splitLandscape}
                onChange={v => update('splitLandscape', v)}
              />
            </Card>
          </View>

          <View style={styles.col}>
            <Card label={t('adv_section_render')}>
              <NumberInput
                label={t('cfg_font_size')}
                value={options.fontSize}
                onChange={v => update('fontSize', v)}
                min={10}
                max={64}
                step={1}
              />
              <NumberInput
                label={t('adv_line_height')}
                value={options.lineHeightMul}
                onChange={v => update('lineHeightMul', v)}
                min={1.0}
                max={3.0}
                step={0.1}
                decimals={1}
              />
              <NumberInput
                label={t('adv_paragraph_spacing')}
                value={options.paragraphSpacing}
                onChange={v => update('paragraphSpacing', v)}
                min={0}
                max={64}
                step={2}
              />
            </Card>
          </View>

          <View style={styles.col}>
            <Card label={t('adv_section_output')}>
              <NumberInput
                label={t('adv_jpeg_quality')}
                value={options.jpegQuality}
                onChange={v => update('jpegQuality', v)}
                min={1}
                max={100}
                step={5}
              />
              <NumberInput
                label={t('adv_threads')}
                value={options.threadCount}
                onChange={v => update('threadCount', v)}
                min={0}
                max={16}
                step={1}
              />
              <SwitchRow
                label={t('adv_text_layer')}
                value={options.embedTextLayer}
                onChange={v => update('embedTextLayer', v)}
              />
              <SwitchRow
                label={t('adv_bookmarks')}
                value={options.embedBookmarks}
                onChange={v => update('embedBookmarks', v)}
              />
            </Card>
          </View>

        </View>
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  body: { padding: Spacing.xl },
  columns: { flexDirection: 'row', gap: Spacing.lg },
  col: { flex: 1 },
});

export default AdvancedScreen;
