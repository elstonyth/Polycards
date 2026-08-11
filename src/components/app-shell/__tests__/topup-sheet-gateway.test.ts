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
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The gateway branch of TopUpSheet (NEXT_PUBLIC_PAYMENTS_PROVIDER=globepay,
// read once at module load) swaps presets, copy, and submit from the
// synchronous mock top-up to a redirect-to-cashier flow that credits nothing.
// This branch shipped with zero tests and a misleading-copy bug was only
// caught by manual browser driving — these pin the behaviors that matter.

const startDeposit = vi.fn();
const topUpCredits = vi.fn();
// The sheet asks the server which channels are on offer every time it opens
// (DEPOSIT_METHODS_ENABLED is RUN_TIME and several routes are prerendered).
const getDepositMethods = vi.fn();
vi.mock('@/lib/actions/vault', () => ({
  startDeposit: (...args: unknown[]) => startDeposit(...args),
  topUpCredits: (...args: unknown[]) => topUpCredits(...args),
  getDepositMethods: () => getDepositMethods(),
}));
// jsdom's window.location is unforgeable, so navigation is observed through
// the leaveFor seam instead of a location spy.
const leaveFor = vi.fn();
vi.mock('@/lib/navigation', () => ({
  leaveFor: (...args: unknown[]) => leaveFor(...args),
}));
// Both hooks poke browser APIs jsdom lacks (focus trap, backdrop-filter
// probing) and neither is under test here.
vi.mock('@/lib/use-modal-a11y', () => ({ useModalA11y: () => {} }));
vi.mock('@/lib/use-liquid-glass', () => ({
  useLiquidGlass: () => {},
  GLASS_SUBTLE: {},
}));

type SheetProps = ComponentProps<typeof import('../TopUpSheet').default>;

let TopUpSheet: (props: SheetProps) => React.ReactNode;

beforeAll(async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  // The provider flag is baked into module-level consts, so it must be set
  // before the module is evaluated.
  vi.stubEnv('NEXT_PUBLIC_PAYMENTS_PROVIDER', 'globepay');
  vi.resetModules();
  TopUpSheet = (await import('../TopUpSheet')).default;
});

let container: HTMLDivElement;
let root: Root;

/** Mount with a given server-side channel list; awaits the open-time fetch. */
async function mount(codes: string[] = ['BQR', 'OB']) {
  getDepositMethods.mockResolvedValue(codes);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(TopUpSheet, {
        open: true,
        balance: 100,
        onClose: () => {},
        onToppedUp: () => {},
      }),
    );
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await mount();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')];
}

function payButton(): HTMLButtonElement {
  const btn = buttons().find((b) => /^Pay RM/.test(b.textContent ?? ''));
  if (!btn) throw new Error('Pay button not found');
  return btn;
}

function methodRadios(): HTMLInputElement[] {
  return [
    ...container.querySelectorAll<HTMLInputElement>(
      'input[type="radio"][name="deposit-method"]',
    ),
  ];
}

function methodRadio(code: string): HTMLInputElement {
  const input = methodRadios().find((radio) => radio.value === code);
  if (!input) throw new Error(`no deposit-method radio for ${code}`);
  return input;
}

/** React needs the DOM property set before the change event, the same trick
 *  typeAmount uses for the amount field. */
async function selectRadio(input: HTMLInputElement) {
  const setChecked = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'checked',
  )!.set!;
  await act(async () => {
    setChecked.call(input, true);
    input.dispatchEvent(new Event('click', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function typeAmount(value: string) {
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Top-up amount in RM"]',
  );
  if (!input) throw new Error('amount input not found');
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!;
  act(() => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('TopUpSheet gateway branch', () => {
  it('offers only gateway-band presets and defaults to RM 300', () => {
    const labels = buttons().map((b) => b.textContent);
    for (const preset of ['RM 300', 'RM 600', 'RM 1,200', 'RM 5,000']) {
      expect(labels).toContain(preset);
    }
    // The mock's RM 10 / RM 25 rungs sit below the gateway floor and would
    // guarantee a rejection.
    expect(labels).not.toContain('RM 10');
    expect(labels).not.toContain('RM 25');
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Top-up amount in RM"]',
      )?.value,
    ).toBe('300');
  });

  it('promises no immediate credit: "Balance once paid" copy and a Pay button', () => {
    const text = container.textContent ?? '';
    expect(text).toContain('Balance once paid');
    expect(text).not.toContain('New balance');
    expect(text).toContain('GlobePay365');
    expect(payButton().textContent).toBe('Pay RM 300.00');
    expect(text).not.toContain('add RM');
    // The mock sheet's "Demo" badge must not ride along on a flow that takes
    // real money at a real cashier.
    expect(text).not.toContain('Demo');
  });

  it('rejects an amount under the gateway floor without calling it', async () => {
    typeAmount('20');
    await click(payButton());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Top-ups must be between RM 30 and RM 10,000.',
    );
    expect(startDeposit).not.toHaveBeenCalled();
    expect(leaveFor).not.toHaveBeenCalled();
  });

  // Above the ceiling there is no Pay button to press: the gateway's max now
  // coincides with the site-wide RM 10,000 top-up cap, which disables the
  // control outright. Pinned because it means the band error above can only
  // ever fire for the floor.
  it('offers no Pay button above the RM 10,000 ceiling', async () => {
    typeAmount('10001');
    expect(buttons().some((b) => /^Pay RM/.test(b.textContent ?? ''))).toBe(
      false,
    );
    expect(startDeposit).not.toHaveBeenCalled();
  });

  it('submits the amount and leaves for the cashier URL on success', async () => {
    startDeposit.mockResolvedValue({
      ok: true,
      url: 'https://cashier.example/pay/abc',
      amount: 300,
    });
    await click(payButton());
    expect(startDeposit).toHaveBeenCalledExactlyOnceWith(300, 'BQR');
    expect(leaveFor).toHaveBeenCalledExactlyOnceWith(
      'https://cashier.example/pay/abc',
    );
    // No success state — nothing has been credited yet.
    expect(container.textContent).not.toContain('ADDED');
  });

  it('sends the picked channel, not the backend default', async () => {
    startDeposit.mockResolvedValue({
      ok: true,
      url: 'https://cashier.example/pay/ob',
      amount: 300,
    });
    // By value, not by DOM position: adding or reordering channels should not
    // break a test about which code gets sent.
    const qr = methodRadio('BQR');
    const onlineBanking = methodRadio('OB');
    // QR is pre-selected because it mirrors GLOBEPAY_DEPOSIT_METHOD; without a
    // picker every customer got it, which is the bug this closes.
    expect(qr.checked).toBe(true);
    expect(onlineBanking.checked).toBe(false);
    await selectRadio(onlineBanking);
    await click(payButton());
    expect(startDeposit).toHaveBeenCalledExactlyOnceWith(300, 'OB');
  });

  it('hides the picker when the operator has retracted a channel, and still sends it', async () => {
    // DEPOSIT_METHODS_ENABLED=OB. A "choice" of one is noise, but the code must
    // still ride on the request — and it must be the surviving channel, not the
    // compiled default (BQR), which the server action would refuse.
    act(() => root.unmount());
    container.remove();
    await mount(['OB']);
    startDeposit.mockResolvedValue({
      ok: true,
      url: 'https://cashier.example/pay/ob-only',
      amount: 300,
    });
    expect(methodRadios()).toHaveLength(0);
    await click(payButton());
    expect(startDeposit).toHaveBeenCalledExactlyOnceWith(300, 'OB');
  });

  it('shows the server error and stays put when the deposit fails', async () => {
    startDeposit.mockResolvedValue({
      ok: false,
      error: 'Please log in first.',
    });
    await click(payButton());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Please log in first.',
    );
    expect(leaveFor).not.toHaveBeenCalled();
  });
});
