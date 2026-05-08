import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import TitleBar from '../ui/TitleBar';
import { Borders, Colors, Spacing, Type } from '../ui/theme';
import { t } from '../i18n';

const STAGE_KEY = ['stage_parse', 'stage_layout', 'stage_render', 'stage_package', 'stage_done'] as const;

interface Props {
  stage: number;     // 0..4
  percent: number;   // 0..100
}

export const ProgressScreen: React.FC<Props> = ({ stage, percent }) => {
  return (
    <View style={styles.root}>
      <TitleBar title={t('prog_title')} />
      <View style={styles.body}>
        <View style={styles.stageRow}>
          {STAGE_KEY.slice(0, 4).map((k, i) => {
            const reached = i < stage;
            const active  = i === stage;
            return (
              <View key={k} style={styles.stageItem}>
                <View
                  style={[
                    styles.stageDot,
                    (reached || active) && styles.stageDotOn,
                  ]}
                />
                <Text
                  style={[
                    Type.small,
                    styles.stageLabel,
                    active && styles.stageLabelActive,
                  ]}>
                  {t(k)}
                </Text>
              </View>
            );
          })}
        </View>

        <View style={styles.bigStage}>
          <Text style={Type.title}>{t(STAGE_KEY[Math.min(stage, 4)])}</Text>
        </View>

        <View style={styles.bar}>
          <View style={[styles.fill, { width: `${Math.max(0, Math.min(100, percent))}%` }]} />
        </View>
        <Text style={[Type.small, styles.percent]}>{percent}%</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  body: { flex: 1, padding: Spacing.xl, justifyContent: 'center' },

  stageRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: Spacing.xxl },
  stageItem: { alignItems: 'center', flex: 1 },
  stageDot: {
    width: 14, height: 14,
    borderWidth: Borders.thick,
    borderColor: Colors.border,
    backgroundColor: Colors.bg,
    marginBottom: Spacing.xs,
  },
  stageDotOn: { backgroundColor: Colors.fg },
  stageLabel: { textAlign: 'center' },
  stageLabelActive: { color: Colors.fg, fontWeight: '700' },

  bigStage: { alignItems: 'center', marginBottom: Spacing.xxl },

  bar: {
    height: 8,
    borderWidth: Borders.default,
    borderColor: Colors.border,
    backgroundColor: Colors.bg,
    overflow: 'hidden',
  },
  fill: { height: '100%', backgroundColor: Colors.fg },
  percent: { textAlign: 'center', marginTop: Spacing.sm },
});

export default ProgressScreen;
