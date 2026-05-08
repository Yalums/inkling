import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import Button from '../ui/Button';
import Card from '../ui/Card';
import NumberInput from '../ui/NumberInput';
import Segmented from '../ui/Segmented';
import TitleBar from '../ui/TitleBar';
import { Colors, Spacing, Type } from '../ui/theme';
import { t } from '../i18n';
import { ConvertOptions } from '../types';

interface Props {
  inputPath: string;
  options: ConvertOptions;
  onOptionsChange: (next: ConvertOptions) => void;
  onPickAgain: () => void;
  onAdvanced: () => void;
  onConvert: () => void;
  onBack: () => void;
}

export const ConfigureScreen: React.FC<Props> = ({
  inputPath, options, onOptionsChange, onPickAgain, onAdvanced, onConvert, onBack,
}) => {
  const update = <K extends keyof ConvertOptions>(k: K, v: ConvertOptions[K]) =>
    onOptionsChange({ ...options, [k]: v });

  // Derive page-format setting from pageWidth/pageHeight + splitLandscape.
  const pageFormat: 'portrait' | 'split' =
    options.splitLandscape ? 'split' : 'portrait';

  return (
    <View style={styles.root}>
      <TitleBar title={t('cfg_input')} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body}>

        <Card label={t('cfg_input')}>
          <Text style={[Type.mono]} numberOfLines={2} ellipsizeMode="middle">
            {inputPath}
          </Text>
          <View style={{ height: Spacing.md }} />
          <Button
            label={t('home_pick')}
            variant="secondary"
            onPress={onPickAgain}
          />
        </Card>

        <Card label={t('cfg_orientation')}>
          <Segmented
            value={options.orientation}
            options={[
              { value: 'horizontal', label: t('cfg_horizontal') },
              { value: 'vertical',   label: t('cfg_vertical') },
            ]}
            onChange={v => update('orientation', v)}
          />
        </Card>

        <Card label={t('cfg_format')}>
          <Segmented
            value={pageFormat}
            options={[
              { value: 'portrait', label: t('cfg_format_portrait') },
              { value: 'split',    label: t('cfg_format_split') },
            ]}
            onChange={v => update('splitLandscape', v === 'split')}
          />
        </Card>

        <Card label={t('cfg_font_size')}>
          <NumberInput
            label={t('cfg_font_size')}
            value={options.fontSize}
            onChange={v => update('fontSize', v)}
            min={10}
            max={64}
            step={1}
          />
        </Card>

        <Button
          label={t('cfg_advanced')}
          variant="ghost"
          onPress={onAdvanced}
        />

        <View style={{ height: Spacing.lg }} />

        <Button
          label={t('cfg_convert')}
          onPress={onConvert}
          disabled={!inputPath || !options.fontPath}
        />
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  body: { padding: Spacing.xl, paddingBottom: Spacing.xxl },
});

export default ConfigureScreen;
