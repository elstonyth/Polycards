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

const { startDeposit, getPaymentLimits, getRegionalPayer } = vi.hoisted(() => ({
  startDeposit: vi.fn(),
  getPaymentLimits: vi.fn(),
  getRegionalPayer: vi.fn(),
}));
vi.mock('@/lib/actions/vault', () => ({
  startDeposit,
  getPaymentLimits,
  getRegionalPayer,
  getDepositMethods: async () => ['BQR', 'OB'],
  topUpCredits: vi.fn(),
}));
vi.mock('@/lib/use-modal-a11y', () => ({ useModalA11y: () => {} }));
vi.mock('@/lib/use-liquid-glass', () => ({
  useLiquidGlass: () => {},
  GLASS_SUBTLE: {},
}));
vi.mock('@/lib/navigation', () => ({ leaveFor: vi.fn() }));

const RM_ONLY = {
  gateway: 'tgpay',
  deposit: { minRm: 50, maxRm: 10000 },
  withdrawal: { minRm: 50, maxRm: 30000 },
  depositsEnabled: true,
  withdrawalsEnabled: true,
  regional: [],
};
const WITH_SGD = {
  ...RM_ONLY,
  regional: [
    {
      gateway: 'a3pay',
      currency: 'SGD',
      depositsEnabled: true,
      withdrawalsEnabled: true,
      deposit: { min: 10, max: 3134.79 },
      withdrawal: { min: 50, max: 10000 },
      rate: { deposit: 3.1405, payout: 3.2405 },
    },
  ],
};

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
  startDeposit.mockResolvedValue({ ok: false, error: 'stopped' });
  // A saved Singapore account settles the name unless a test says otherwise.
  getRegionalPayer.mockResolvedValue({
    nameOnFile: true,
    realName: 'Tan Ah Kow',
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount(limits: unknown) {
  getPaymentLimits.mockResolvedValue(limits);
  const { default: TopUpSheet } = await import('../TopUpSheet');
  await act(async () => {
    root.render(
      createElement(TopUpSheet, {
        open: true,
        balance: 100,
        onClose: vi.fn(),
        onToppedUp: vi.fn(),
      }),
    );
  });
}
const button = (text: string) =>
  [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(text),
  );
const amountInput = () =>
  container.querySelector<HTMLInputElement>(
    'input[aria-label^="Top-up amount"]',
  );

describe('TopUpSheet — choose a currency first', () => {
  it('opens on the currency list, with no amount form yet', async () => {
    await mount(RM_ONLY);
    expect(container.textContent).toContain('Choose a currency');
    expect(button('Malaysian Ringgit')).toBeTruthy();
    expect(amountInput()).toBeNull();
  });

  it("lists Singapore Dollar with today's rate only while the SGD rail is open", async () => {
    await mount(RM_ONLY);
    expect(button('Singapore Dollar')).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(container);
    await mount(WITH_SGD);
    expect(button('Singapore Dollar')?.textContent).toContain(
      'S$1 = RM 3.1405',
    );
  });

  it('choosing RM shows only the RM form', async () => {
    await mount(WITH_SGD);
    await act(async () => button('Malaysian Ringgit')!.click());
    expect(amountInput()?.getAttribute('aria-label')).toBe(
      'Top-up amount in RM',
    );
    expect(container.textContent).toContain('Malaysian Ringgit (RM)');
    expect(container.textContent).not.toContain('Name on your bank account');
    expect(container.textContent).not.toContain('Choose a currency');
  });

  it('choosing S$ with a saved Singapore account: no name to type, and Change goes back to the list', async () => {
    await mount(WITH_SGD);
    await act(async () => button('Singapore Dollar')!.click());
    expect(amountInput()?.getAttribute('aria-label')).toBe(
      'Top-up amount in S$',
    );
    // The saved account's holder is the payer name.
    expect(getRegionalPayer).toHaveBeenCalledWith('SGD');
    expect(container.textContent).not.toContain('Name on your bank account');
    expect(container.textContent).toContain('PayNow QR');
    await act(async () => button('Change')!.click());
    expect(container.textContent).toContain('Choose a currency');
    expect(amountInput()).toBeNull();
  });

  it('pays in S$ with the rate it showed, so the backend can refuse a moved one', async () => {
    await mount(WITH_SGD);
    await act(async () => button('Singapore Dollar')!.click());
    await act(async () => button('Pay')!.click());
    expect(startDeposit).toHaveBeenCalledWith(100, 'BQR', {
      currency: 'SGD',
      quotedRate: 3.1405,
    });
    // The refusal re-reads the rails, so a moved rate shows before a retry.
    expect(getPaymentLimits).toHaveBeenCalledTimes(2);
  });

  it('no saved Singapore account: asks for the account name, pre-filled with the real name, and sends it', async () => {
    getRegionalPayer.mockResolvedValue({
      nameOnFile: false,
      realName: 'Tan Ah Kow',
    });
    await mount(WITH_SGD);
    await act(async () => button('Singapore Dollar')!.click());
    expect(container.textContent).toContain('Name on your bank account');
    const name = container.querySelector<HTMLInputElement>(
      'input[autocomplete="name"]',
    );
    expect(name?.value).toBe('Tan Ah Kow');
    await act(async () => button('Pay')!.click());
    expect(startDeposit).toHaveBeenCalledWith(100, 'BQR', {
      currency: 'SGD',
      quotedRate: 3.1405,
      payerName: 'Tan Ah Kow',
    });
  });

  it('an empty account name holds the pay button', async () => {
    getRegionalPayer.mockResolvedValue({ nameOnFile: false, realName: null });
    await mount(WITH_SGD);
    await act(async () => button('Singapore Dollar')!.click());
    expect(button('Enter the account name')?.disabled).toBe(true);
    expect(button('Pay')).toBeUndefined();
  });
});
