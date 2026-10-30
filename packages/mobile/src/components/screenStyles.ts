/**
 * Shared screen styles — the cards moved out of the old Settings scroll keep
 * their original look by importing this one StyleSheet rather than carrying
 * three divergent copies.
 */

import { StyleSheet } from 'react-native';
import { colors, glass, layout, spacing } from '../theme';

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  scroll: { flex: 1 },
  content: {
    alignSelf: 'center',
    maxWidth: layout.contentMaxWidth,
    padding: spacing.md,
    paddingBottom: spacing.xl,
    width: '100%',
  },
  rowBetween: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  link: { color: colors.info, fontSize: 15, fontWeight: '600' },
  serverRow: {
    // Opaque — the swipeable row is a lid sliding over the Remove action;
    // anything translucent lets the red panel bleed through at rest.
    backgroundColor: colors.card,
    borderTopColor: glass.border,
    borderTopWidth: 1,
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  serverEditRow: {
    backgroundColor: colors.card,
    borderTopColor: glass.border,
    borderTopWidth: 1,
    paddingVertical: spacing.sm,
  },
  swipeDelete: {
    alignItems: 'center',
    backgroundColor: colors.danger,
    borderTopColor: colors.cardBorder,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: spacing.xs,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  swipeDeleteText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  serverTitleRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  serverLabel: { color: colors.text, fontSize: 15, fontWeight: '600' },
  meta: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  input: {
    backgroundColor: glass.surface,
    borderColor: glass.border,
    borderTopColor: glass.borderTop,
    borderRadius: 14,
    borderWidth: 1,
    color: colors.text,
    fontSize: 15,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  buttonFlex: { flex: 1 },
  feedRow: { borderTopColor: glass.border, borderTopWidth: 1, paddingVertical: spacing.sm },
  docRow: {
    alignItems: 'center',
    borderTopColor: glass.border,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingVertical: spacing.sm + 2,
  },
  docIcon: {
    alignItems: 'center',
    backgroundColor: 'rgba(63,185,80,0.12)',
    borderRadius: 8,
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
  docLabel: { color: colors.text, fontSize: 14, fontWeight: '600' },
  docHint: { color: colors.textMuted, fontSize: 11, marginTop: 1 },
  feedLabel: { color: colors.text, fontSize: 14, fontWeight: '600' },
  feedLabelRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
  feedCustom: { color: colors.textMuted, fontSize: 11 },
  feedUrl: { color: colors.info, fontSize: 12, marginTop: 2 },
  footer: {
    alignSelf: 'center',
    color: colors.textMuted,
    fontSize: 12,
    marginTop: spacing.lg,
  },
  syncError: { color: colors.danger, fontSize: 12, marginTop: spacing.sm },
  syncErrorDetail: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
});
