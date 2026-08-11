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
import { PendingDeposits } from '../PendingDeposits';
import type { PendingDeposit } from '@/lib/actions/vault';

// The row exists because the ledger cannot show an unsettled deposit: a
// customer who paid and came back saw no trace of their money. What matters is
// that it appears while the deposit is in flight, keeps asking the server, and
// disappears on its own when the credit lands — not how it looks.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

let container: HTMLDivElement;
let root: Root;

const deposit = (over: Partial<PendingDeposit> = {}): PendingDeposit => ({
  reference: 'PC-abc',
  amount: 500,
  method: 'BQR',
  startedLabel: '2 minutes ago',
  overdue: false,
  ...over,
});

async function mount(deposits: PendingDeposit[]) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(PendingDeposits, { deposits }));
  });
}

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('PendingDeposits', () => {
  it('names the amount and the support reference while a payment confirms', async () => {
    await mount([deposit()]);
    expect(container.textContent).toMatch(/Confirming your RM\s?500/i);
    expect(container.textContent).toContain('PC-abc');
    // Elapsed is stamped server-side by getPendingDeposits, so it is a plain
    // string here — no clock in the component, nothing to hydrate-mismatch.
    expect(container.textContent).toContain('started 2 minutes ago');
    // The reassurance is the point of the row — without it a customer who
    // cannot see their money assumes the payment failed.
    expect(container.textContent).toMatch(/lands automatically/i);
  });

  // Nothing at all, not an empty container: the ledger below is the page.
  it('renders nothing when no deposit is in flight', async () => {
    await mount([]);
    expect(container.textContent).toBe('');
  });

  it('re-asks the server while the deposit is outstanding', async () => {
    await mount([deposit()]);
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  // The polling must stop when the credit lands, or every settled top-up
  // leaves a page refreshing itself forever.
  it('stops polling once the list comes back empty', async () => {
    await mount([deposit()]);
    await act(async () => {
      root.render(createElement(PendingDeposits, { deposits: [] }));
    });
    refresh.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  // Past the backend's stale window the copy must stop promising an imminent
  // credit — the honest line is "not lost, quote this reference".
  it('switches to the support wording on a long-outstanding deposit', async () => {
    await mount([deposit({ overdue: true, startedLabel: '183 minutes ago' })]);
    expect(container.textContent).toMatch(/Still waiting on RM\s?500/i);
    expect(container.textContent).toMatch(/not lost/i);
  });
});
