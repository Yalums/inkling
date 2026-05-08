import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import Button from '../ui/Button';
import Card from '../ui/Card';
import TitleBar from '../ui/TitleBar';
import { Colors, Spacing, Type } from '../ui/theme';
import { t } from '../i18n';

interface Props {
  ok: boolean;
  outputPath: string | null;
  errorMessage?: string | null;
  onAgain: () => void;
}

export const ResultScreen: React.FC<Props> = ({ ok, outputPath, errorMessage, onAgain }) => {
  return (
    <View style={styles.root}>
      <TitleBar title={ok ? t('result_ok_title') : t('result_err_title')} />
      <View style={styles.body}>
        {ok && outputPath ? (
          <Card label={t('result_output')}>
            <Text style={Type.mono} numberOfLines={3} ellipsizeMode="middle">
              {outputPath}
            </Text>
          </Card>
        ) : (
          <Card>
            <Text style={Type.body}>{errorMessage || '—'}</Text>
          </Card>
        )}

        <View style={{ flex: 1 }} />

        <Button label={t('result_again')} onPress={onAgain} />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  body: { flex: 1, padding: Spacing.xl, paddingBottom: Spacing.xxl },
});

export default ResultScreen;
