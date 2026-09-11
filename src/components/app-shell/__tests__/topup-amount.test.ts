// @vitest-environment jsdom
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const { startDeposit, getPaymentLimits } = vi.hoisted(() => ({
  startDeposit: vi.fn(),
  getPaymentLimits: vi.fn(),
}));
vi.mock('@/lib/actions/vault', () => ({
  startDeposit,
  getPaymentLimits,
  getDepositMethods: async () => ['BQR', 'OB'],
  topUpCredits: vi.fn(),
}));
vi.mock('@/lib/use-modal-a11y', () => ({ useModalA11y: () => {} }));
vi.mock('@/lib/use-liquid-glass', () => ({
  useLiquidGlass: () => {},
  GLASS_SUBTLE: {},
}));
vi.mock('@/lib/navigation', () => ({ leaveFor: vi.fn() }));

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubEnv('NEXT_PUBLIC_PAYMENTS_PROVIDER', 'tgpay');
});
beforeEach(() => {
  vi.clearAllMocks();
  getPaymentLimits.mockResolvedValue({
    gateway: 'tgpay',
    deposit: { minRm: 50, maxRm: 10000 },
    withdrawal: { minRm: 50, maxRm: 30000 },
    depositsEnabled: true,
    withdrawalsEnabled: true,
  });
  startDeposit.mockResolvedValue({
    ok: false,
    error: 'Test checkout stopped.',
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount() {
  const { default: TopUpSheet } = await import('../TopUpSheet');
  await act(async () => {
    root.render(
      createElement(TopUpSheet, {
        open: true,
        balance: 0,
        onClose: vi.fn(),
        onToppedUp: vi.fn(),
      }),
    );
  });
}

async function enterAmount(value: string) {
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Top-up amount in RM"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input;
}

function submitButton() {
  return Array.from(container.querySelectorAll('button')).find((button) =>
    /^(Pay |Enter )/.test(button.textContent ?? ''),
  )!;
}

describe('top-up amount validation before gateway checkout', () => {
  it.each([
    '0',
    '0.01',
    '49.99',
    '-1',
    '10000.01',
    '1000000',
    'abc',
    '300abc',
    '50.001',
  ])(
    'explains the allowed range and prevents checkout for %s',
    async (value) => {
      await mount();
      const input = await enterAmount(value);
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(container.textContent).toContain('RM 50.00');
      expect(container.textContent).toContain('RM 10,000.00');
      expect(submitButton().disabled).toBe(true);
      await act(async () => submitButton().click());
      expect(startDeposit).not.toHaveBeenCalled();
    },
  );

  it.each(['50', '50.01', '10000'])(
    'allows an in-range amount %s without changing its value',
    async (value) => {
      await mount();
      await enterAmount(value);
      expect(submitButton().disabled).toBe(false);
      await act(async () => submitButton().click());
      expect(startDeposit).toHaveBeenCalledWith(Number(value), 'BQR');
    },
  );

  it('uses active gateway limits when they arrive', async () => {
    getPaymentLimits.mockResolvedValue({
      gateway: 'alternate',
      deposit: { minRm: 100, maxRm: 1000 },
      withdrawal: { minRm: 50, maxRm: 30000 },
      depositsEnabled: true,
      withdrawalsEnabled: true,
    });
    await mount();
    await enterAmount('50');
    expect(submitButton().disabled).toBe(true);
    expect(container.textContent).toContain('RM 100.00');
    expect(container.textContent).toContain('RM 1,000.00');
    await enterAmount('1000');
    expect(submitButton().disabled).toBe(false);
  });
});
