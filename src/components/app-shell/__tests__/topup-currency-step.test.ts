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
    savedName: 'TAN AH KOW',
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
const nameInput = () =>
  container.querySelector<HTMLInputElement>('input[autocomplete="name"]');
// React listens for the native input event; set the value through the
// prototype setter so React sees the change.
const type = (el: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
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

  it('choosing S$ with a saved Singapore account: its holder shown, nothing to type, and Change goes back to the list', async () => {
    await mount(WITH_SGD);
    await act(async () => button('Singapore Dollar')!.click());
    expect(amountInput()?.getAttribute('aria-label')).toBe(
      'Top-up amount in S$',
    );
    // The saved account's holder is the payer name, shown, not asked.
    expect(getRegionalPayer).toHaveBeenCalledWith('SGD');
    expect(container.textContent).toContain('Paying from the account of');
    expect(container.textContent).toContain('TAN AH KOW');
    expect(nameInput()).toBeNull();
    expect(container.textContent).toContain('PayNow QR');
    await act(async () => button('Change')!.click());
    expect(container.textContent).toContain('Choose a currency');
    expect(amountInput()).toBeNull();
  });

  it('shows a closed S$ rail as Paused, not as nothing', async () => {
    await mount({
      ...WITH_SGD,
      regional: [{ ...WITH_SGD.regional[0], depositsEnabled: false }],
    });
    const sgd = button('Singapore Dollar');
    expect(sgd?.disabled).toBe(true);
    expect(sgd?.textContent).toMatch(/Paused/);
  });

  it('keeps the refusal on screen when the re-read finds the S$ rail closed', async () => {
    await mount(WITH_SGD);
    await act(async () => button('Singapore Dollar')!.click());
    startDeposit.mockResolvedValueOnce({
      ok: false,
      error: 'SGD payments are paused right now — please try again shortly.',
    });
    getPaymentLimits.mockResolvedValue({
      ...WITH_SGD,
      regional: [{ ...WITH_SGD.regional[0], depositsEnabled: false }],
    });
    await act(async () => button('Pay')!.click());
    expect(container.textContent).toContain('Choose a currency');
    expect(container.textContent).toContain('SGD payments are paused');
  });

  it('keeps the S$ rail when the re-read after a refusal fails', async () => {
    await mount(WITH_SGD);
    await act(async () => button('Singapore Dollar')!.click());
    // getPaymentLimits answers its defaults (gateway "unknown", no rails)
    // when the backend cannot be reached.
    getPaymentLimits.mockResolvedValue({ ...RM_ONLY, gateway: 'unknown' });
    await act(async () => button('Pay')!.click());
    expect(amountInput()?.getAttribute('aria-label')).toBe(
      'Top-up amount in S$',
    );
  });

  // A3Pay matches a payment ONLY by its exact amount, and may ask for a few
  // cents more than the sheet showed (S$100 -> S$100.01).
  it('tells an S$ payer to transfer the exact amount the next page shows', async () => {
    await mount(WITH_SGD);
    await act(async () => button('Singapore Dollar')!.click());
    expect(container.textContent).toMatch(/exact amount/i);
    expect(container.textContent).toMatch(/cents included/i);
    act(() => root.unmount());
    root = createRoot(container);
    await mount(WITH_SGD);
    await act(async () => button('Malaysian Ringgit')!.click());
    expect(container.textContent).not.toMatch(/cents included/i);
  });

  it('pays in S$ with the rate it showed, so the backend can refuse a moved one', async () => {
    await mount(WITH_SGD);
    await act(async () => button('Singapore Dollar')!.click());
    await act(async () => button('Pay')!.click());
    expect(startDeposit).toHaveBeenCalledWith(100, 'BQR', {
      currency: 'SGD',
      quotedRate: 3.1405,
      payerName: 'TAN AH KOW',
    });
    // The refusal re-reads the rails, so a moved rate shows before a retry.
    expect(getPaymentLimits).toHaveBeenCalledTimes(2);
  });

  it('no saved Singapore account: asks for the account name, pre-filled with the real name, and sends it', async () => {
    getRegionalPayer.mockResolvedValue({
      savedName: null,
      realName: 'Tan Ah Kow',
    });
    await mount(WITH_SGD);
    await act(async () => button('Singapore Dollar')!.click());
    expect(container.textContent).toContain('Name on your bank account');
    expect(nameInput()?.value).toBe('Tan Ah Kow');
    await act(async () => button('Pay')!.click());
    expect(startDeposit).toHaveBeenCalledWith(100, 'BQR', {
      currency: 'SGD',
      quotedRate: 3.1405,
      payerName: 'Tan Ah Kow',
    });
  });

  it('an empty account name holds the pay button', async () => {
    getRegionalPayer.mockResolvedValue({ savedName: null, realName: null });
    await mount(WITH_SGD);
    await act(async () => button('Singapore Dollar')!.click());
    expect(button('Enter the account name')?.disabled).toBe(true);
    expect(button('Pay')).toBeUndefined();
  });

  it('Change lets a customer paying from another account correct the saved name', async () => {
    await mount(WITH_SGD);
    await act(async () => button('Singapore Dollar')!.click());
    const change = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Change the name on the paying account"]',
    );
    await act(async () => change!.click());
    expect(nameInput()?.value).toBe('TAN AH KOW');
    await act(async () => type(nameInput()!, 'LIM MEI LING'));
    await act(async () => button('Pay')!.click());
    expect(startDeposit).toHaveBeenCalledWith(100, 'BQR', {
      currency: 'SGD',
      quotedRate: 3.1405,
      payerName: 'LIM MEI LING',
    });
  });

  it('a failed lookup asks for the name — never a stuck button', async () => {
    getRegionalPayer.mockRejectedValue(new Error('network'));
    await mount(WITH_SGD);
    await act(async () => button('Singapore Dollar')!.click());
    expect(nameInput()?.value).toBe('');
    expect(button('Enter the account name')?.disabled).toBe(true);
    await act(async () => type(nameInput()!, 'Lim Mei Ling'));
    await act(async () => button('Pay')!.click());
    expect(startDeposit).toHaveBeenCalledWith(100, 'BQR', {
      currency: 'SGD',
      quotedRate: 3.1405,
      payerName: 'Lim Mei Ling',
    });
  });

  it('says it is checking while the lookup is on its way', async () => {
    getRegionalPayer.mockReturnValue(new Promise(() => {}));
    await mount(WITH_SGD);
    await act(async () => button('Singapore Dollar')!.click());
    expect(button('Checking')?.disabled).toBe(true);
    expect(button('Enter a valid amount')).toBeUndefined();
  });
});
