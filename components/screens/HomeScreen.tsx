import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Borders, Colors, Spacing, Type } from '../ui/theme';
import Button from '../ui/Button';
import TitleBar from '../ui/TitleBar';
import { t } from '../i18n';

interface Props {
  onPick: () => void;
}

export const HomeScreen: React.FC<Props> = ({ onPick }) => {
  return (
    <View style={styles.root}>
      <TitleBar title={t('app_title')} />
      <View style={styles.body}>
        <Text style={[Type.display, styles.brand]}>{t('app_title')}</Text>
        <Text style={[Type.small, styles.tagline]}>{t('app_subtitle')}</Text>

        <View style={styles.spacer} />

        <View style={styles.heroBox}>
          <Text style={[Type.body, styles.heroHint]}>
            {t('home_supports')}
          </Text>
          <View style={{ height: Spacing.lg }} />
          <Button label={t('home_pick')} onPress={onPick} />
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  body: { flex: 1, paddingHorizontal: Spacing.xl, paddingTop: Spacing.xxl },
  brand: { textAlign: 'center', letterSpacing: 1 },
  tagline: { textAlign: 'center', marginTop: Spacing.sm },
  spacer: { flex: 1 },
  heroBox: {
    borderWidth: Borders.thick,
    borderColor: Colors.border,
    padding: Spacing.xl,
    marginBottom: Spacing.xxl,
  },
  heroHint: { textAlign: 'center', color: Colors.textMuted },
});

export default HomeScreen;
