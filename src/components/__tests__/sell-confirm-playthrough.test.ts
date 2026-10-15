// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The free part of a sale (bonus-credit share, the welcome pull) is for
// opening packs, not withdrawable (#712, kept 2026-10-15). The confirm
// names that part; a sale with none reads as before.

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

describe('SellConfirmModal — sale with a free part', () => {
  test('names the part that is for opening packs', () => {
    const text = render(270);
    expect(text).toContain('Sell for RM 270.00');
    expect(text).toContain('For packs');
    expect(text).toContain(
      'RM 270.00 of this sale is for opening packs (the part paid with bonus credit, or the welcome pack’s card). Withdrawals stay locked until it is used on packs.',
    );
  });

  test('any other sale says nothing about packs', () => {
    const text = render(0);
    expect(text).toContain('Sell for RM 270.00');
    expect(text).not.toContain('For packs');
    expect(text).not.toContain('for opening packs');
  });
});
