/**
 * Adaptive-shell tests: the width-tier breakpoints that choose compact /
 * Duo-rail / iPad-sidebar, and the Grid cell wrapping those tiers rely on.
 */

import React from 'react';
import { Text, View } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { Grid } from '../components/ui';
import { gridColumnsFor, widthTierFor } from '../hooks/useWidthTier';

describe('widthTierFor', () => {
  it('is compact below 680pt — phones, folded Duo, third-split', () => {
    expect(widthTierFor(320)).toBe('compact');
    expect(widthTierFor(390)).toBe('compact');
    expect(widthTierFor(430)).toBe('compact');
    expect(widthTierFor(679.9)).toBe('compact');
  });

  it('is medium 680–1023pt — unfolded Duo, half-split, iPad mini', () => {
    expect(widthTierFor(680)).toBe('medium');
    expect(widthTierFor(760)).toBe('medium');
    expect(widthTierFor(820)).toBe('medium');
    expect(widthTierFor(1023.9)).toBe('medium');
  });

  it('is regular from 1024pt — full-size iPad', () => {
    expect(widthTierFor(1024)).toBe('regular');
    expect(widthTierFor(1180)).toBe('regular');
    expect(widthTierFor(1366)).toBe('regular');
  });

  it('keeps the grid single-column on compact, two-column above', () => {
    expect(gridColumnsFor('compact')).toBe(1);
    expect(gridColumnsFor('medium')).toBe(2);
    expect(gridColumnsFor('regular')).toBe(2);
  });
});

const widthCells = (
  container: { queryAll: (p: (n: any) => boolean) => unknown[] },
  w: string,
) => container.queryAll((n) => n.props?.style?.width === w);

describe('Grid', () => {
  it('renders children unwrapped at one column', async () => {
    const { container } = await render(
      <Grid columns={1}>
        <View testID="a" />
        <View testID="b" />
      </Grid>,
    );
    expect(screen.getByTestId('a')).toBeTruthy();
    expect(screen.getByTestId('b')).toBeTruthy();
    // No percentage cells — the column itself owns the width.
    expect(widthCells(container, '100%')).toHaveLength(0);
  });

  it('wraps each child in a 50% cell at two columns', async () => {
    await render(
      <Grid columns={2}>
        <View testID="a" />
        <View testID="b" />
        <View testID="c" />
      </Grid>,
    );
    for (const id of ['a', 'b', 'c']) {
      const cell = screen.getByTestId(id).parent;
      expect(cell?.props.style).toMatchObject({ width: '50%' });
    }
  });

  it('drops conditional children instead of leaving empty cells', async () => {
    const showSecond = false;
    const { container } = await render(
      <Grid columns={2}>
        <View testID="a" />
        {showSecond ? <View testID="b" /> : null}
        <View testID="c" />
      </Grid>,
    );
    expect(screen.queryByTestId('b')).toBeNull();
    // Two real children → two cells; the hidden card left no hole.
    expect(widthCells(container, '50%')).toHaveLength(2);
    expect(screen.getByTestId('c')).toBeTruthy();
  });

  it('flattens keyed arrays so conditional card groups become cells', async () => {
    // The dashboard passes [CardA, CardB] as one ternary child — an array, not
    // a fragment — precisely so both land as cells instead of sharing one.
    const pair = [<Text key="x">x</Text>, <Text key="y">y</Text>];
    const { container } = await render(
      <Grid columns={2}>
        {pair}
        <View testID="c" />
      </Grid>,
    );
    expect(widthCells(container, '50%')).toHaveLength(3);
  });
});
