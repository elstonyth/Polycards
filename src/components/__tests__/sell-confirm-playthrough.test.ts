// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// A card opened with bonus credit or a vault pack sells back as NORMAL credit,
// but its bonus share must be played through once before it can be withdrawn
// (2026-10-09). The confirm says so; an ordinary sale reads as before.

vi.mock('@/lib/use-liquid-glass', () => ({
  useLiquidGlass: () => {},
  GLASS_SUBTLE: {},
}));
vi.mock('@/components/SlabImage', () => ({ SlabImage: () => null }));

const SellConfirmModal = (await import('../SellConfirmModal')).default;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(bonus: number) {
  act(() =>
    root.render(
      createElement(SellConfirmModal, {
        open: true,
        cardName: 'Pikachu',
        image: '/x.webp',
        fmv: 300,
        rateType: 'flat',
        percent: 90,
        netCredit: 270,
        bonus,
        onConfirm: () => {},
        onCancel: () => {},
      }),
    ),
  );
  return document.body.textContent ?? '';
}

describe('SellConfirmModal — sale from bonus play', () => {
  test('pays normal credit and names the part to play through', () => {
    const text = render(270);
    expect(text).toContain('Sell for RM 270.00');
    expect(text).not.toContain('bonus +');
    expect(text).toContain('To play through');
    expect(text).toContain(
      'RM 270.00 of it came from bonus credit or a vault pack',
    );
  });

  test('an ordinary sale reads exactly as before', () => {
    const text = render(0);
    expect(text).toContain('Sell for RM 270.00');
    expect(text).not.toContain('play through');
  });
});
