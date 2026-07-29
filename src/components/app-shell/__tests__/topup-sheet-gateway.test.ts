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
vi.mock('@/lib/actions/vault', () => ({
  startDeposit: (...args: unknown[]) => startDeposit(...args),
  topUpCredits: (...args: unknown[]) => topUpCredits(...args),
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

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(TopUpSheet, {
        open: true,
        balance: 100,
        onClose: () => {},
        onToppedUp: () => {},
      }),
    );
  });
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
  it('offers only gateway-band presets and defaults to RM 50', () => {
    const labels = buttons().map((b) => b.textContent);
    for (const preset of ['RM 30', 'RM 50', 'RM 100', 'RM 200']) {
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
    ).toBe('50');
  });

  it('promises no immediate credit: "Balance once paid" copy and a Pay button', () => {
    const text = container.textContent ?? '';
    expect(text).toContain('Balance once paid');
    expect(text).not.toContain('New balance');
    expect(text).toContain('GlobePay365');
    expect(payButton().textContent).toBe('Pay RM 50.00');
    expect(text).not.toContain('add RM');
    // The mock sheet's "Demo" badge must not ride along on a flow that takes
    // real money at a real cashier.
    expect(text).not.toContain('Demo');
  });

  it.each(['20', '1001'])(
    'rejects RM %s in the sheet without calling the gateway',
    async (amount) => {
      typeAmount(amount);
      await click(payButton());
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        'Top-ups must be between RM 30 and RM 1,000.',
      );
      expect(startDeposit).not.toHaveBeenCalled();
      expect(leaveFor).not.toHaveBeenCalled();
    },
  );

  it('submits the amount and leaves for the cashier URL on success', async () => {
    startDeposit.mockResolvedValue({
      ok: true,
      url: 'https://cashier.example/pay/abc',
      amount: 50,
    });
    await click(payButton());
    expect(startDeposit).toHaveBeenCalledExactlyOnceWith(50);
    expect(leaveFor).toHaveBeenCalledExactlyOnceWith(
      'https://cashier.example/pay/abc',
    );
    // No success state — nothing has been credited yet.
    expect(container.textContent).not.toContain('ADDED');
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
