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

// The provider watches the customer's own in-flight gateway deposits so the
// balance updates BY ITSELF when the payment clears — the header chip, the
// money dot and every server-rendered money surface, from one poll. What is
// pinned here: it only claims credit when the balance actually moved, it stops
// polling when nothing is outstanding, and it never polls for a logged-out
// visitor.

const getPendingDeposits = vi.fn();
const getCreditBalance = vi.fn();
vi.mock('@/lib/actions/vault', () => ({
  getPendingDeposits: () => getPendingDeposits(),
  getCreditBalance: () => getCreditBalance(),
}));

const refresh = vi.fn();
// ONE router object, as next/navigation returns — a fresh object per render
// would restart the watcher's effect on every render and mask what it does.
const router = { refresh };
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const refreshCreditDot = vi.fn();
vi.mock('../CreditDotProvider', () => ({
  useCreditDot: () => ({ refresh: refreshCreditDot }),
}));

// The sheet drags in the whole top-up flow (channel fetch, focus trap, glass)
// and none of it is under test here.
vi.mock('../TopUpSheet', () => ({ default: () => null }));
vi.mock('@/lib/use-liquid-glass', () => ({
  useLiquidGlass: () => {},
  GLASS_ACCENT: {},
}));

let customer: { id: string } | null = { id: 'cus_1' };
vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({ customer }),
}));

const deposit = (reference: string) => ({
  reference,
  amount: 500,
  method: 'BQR',
  startedLabel: 'just now',
  overdue: false,
});

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  customer = { id: 'cus_1' };
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

/** Mounts the provider with a probe that prints the context balance. */
async function mount() {
  const { TopUpProvider, useTopUp } = await import('../TopUpProvider');
  const Probe = () => {
    const { balance } = useTopUp();
    return createElement('span', null, balance == null ? '—' : String(balance));
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(TopUpProvider, null, createElement(Probe)));
  });
}

/** One poll interval, plus the promise turns each tick awaits. */
async function nextPoll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
}

describe('TopUpProvider — gateway deposit watch', () => {
  it('credits the balance and says so when the payment clears', async () => {
    getPendingDeposits
      .mockResolvedValueOnce([deposit('PC-1')]) // outstanding
      .mockResolvedValueOnce([]); // settled at the gateway
    getCreditBalance
      .mockResolvedValueOnce(100) // the provider's own login-time fetch
      .mockResolvedValueOnce(100) // baseline taken while the payment is out
      .mockResolvedValue(600); // after the credit lands

    await mount();
    await nextPoll();

    expect(container.textContent).toContain('600');
    expect(container.textContent).toContain('RM 500.00 added to your balance');
    // Server-rendered money surfaces (ledger, /me, /wallet) must re-read.
    expect(refresh).toHaveBeenCalled();
    expect(refreshCreditDot).toHaveBeenCalled();
  });

  // A deposit can leave the pending list by FAILING. Announcing credit then
  // would be a lie the customer acts on.
  it('stays silent when a deposit vanishes without the balance moving', async () => {
    getPendingDeposits
      .mockResolvedValueOnce([deposit('PC-1')])
      .mockResolvedValueOnce([]);
    getCreditBalance.mockResolvedValue(100);

    await mount();
    await nextPoll();

    expect(container.textContent).not.toContain('added to your balance');
    expect(container.textContent).toContain('100');
  });

  // The common case: nobody is mid-payment. One request per session, then it
  // must go quiet rather than poll the read budget forever.
  it('stops after one look when nothing is outstanding', async () => {
    getPendingDeposits.mockResolvedValue([]);
    getCreditBalance.mockResolvedValue(100);

    await mount();
    expect(getPendingDeposits).toHaveBeenCalledTimes(1);
    await nextPoll();
    await nextPoll();
    expect(getPendingDeposits).toHaveBeenCalledTimes(1);
    // Only the provider's own login-time balance read — the watcher took no
    // baseline, because there is nothing to compare it against later.
    expect(getCreditBalance).toHaveBeenCalledTimes(1);
  });

  it('never polls for a logged-out visitor', async () => {
    customer = null;
    await mount();
    await nextPoll();
    expect(getPendingDeposits).not.toHaveBeenCalled();
  });

  // Two consecutive payments: the second must be watched exactly like the
  // first, not swallowed because the watcher already fired once.
  it('keeps watching while a deposit is still outstanding', async () => {
    getPendingDeposits
      .mockResolvedValueOnce([deposit('PC-1')])
      .mockResolvedValueOnce([deposit('PC-1')])
      .mockResolvedValueOnce([]);
    getCreditBalance
      .mockResolvedValueOnce(100) // login-time fetch
      .mockResolvedValueOnce(100) // baseline
      .mockResolvedValue(600); // once it lands

    await mount();
    await nextPoll();
    expect(container.textContent).not.toContain('added to your balance');
    await nextPoll();
    expect(container.textContent).toContain('RM 500.00 added to your balance');
  });
});
