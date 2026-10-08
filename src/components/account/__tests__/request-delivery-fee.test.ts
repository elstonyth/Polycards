// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { VaultItem } from '@/lib/actions/vault';
import type { AddressView } from '@/lib/actions/delivery';

// Reward cards ship through POST /store/rewards/withdraw, which charges no
// fee. The preview used to price the whole selection, so a task-reward card
// alone showed "Total — deducted from balance RM 15.00" (2026-10-08 report).

vi.mock('@/lib/actions/delivery', () => ({
  shipVaultCards: vi.fn(),
  addAddress: vi.fn(),
}));
vi.mock('@/components/SlabImage', () => ({
  SlabImage: () => createElement('div'),
}));
vi.mock('@/lib/use-liquid-glass', () => ({
  useLiquidGlass: () => {},
  GLASS_SUBTLE: {},
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    createElement('a', { href }, children),
}));

import RequestDeliveryModal from '../RequestDeliveryModal';

const ADDRESS: AddressView = {
  id: 'addr_1',
  name: 'Tan Kah Meng',
  firstName: 'Tan',
  lastName: 'Kah Meng',
  line1: 'S-11-3A Waltz Residence',
  line2: null,
  city: 'Kuala Lumpur',
  province: 'Kuala Lumpur',
  postalCode: '58200',
  countryCode: 'MY',
  phone: null,
} as AddressView;

const item = (pullId: string, source: string, priceMyr: number) =>
  ({ pullId, source, card: { priceMyr } }) as unknown as VaultItem;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (items: VaultItem[]) =>
  act(() =>
    root.render(
      createElement(RequestDeliveryModal, {
        open: true,
        items,
        addresses: [ADDRESS],
        onClose: () => {},
        onSubmitted: () => {},
      }),
    ),
  );

describe('RequestDeliveryModal fee preview', () => {
  test('a reward-only selection previews no charge', () => {
    render([item('pull_r', 'reward', 12)]);
    const text = host.textContent ?? '';
    expect(text).toContain('Reward cards ship free.');
    expect(text).not.toContain('deducted from balance');
    expect(text).not.toContain('RM 15.00');
  });

  test('a mixed selection prices only the ordinary cards', () => {
    // RM 190 paid + RM 500 reward: pricing both would cross the RM 200
    // protection line and add insurance the backend never charges.
    render([item('pull_a', 'pack', 190), item('pull_r', 'reward', 500)]);
    const text = host.textContent ?? '';
    expect(text).toContain('deducted from your credit balance');
    expect(text).toContain('Total — deducted from balance');
    expect(text).toContain('RM 15.00');
    expect(text).not.toContain('Insurance');
  });
});
