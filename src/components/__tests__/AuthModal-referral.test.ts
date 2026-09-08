// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const getReferralPrefill = vi.fn<() => Promise<string | null>>();
vi.mock('@/lib/actions/auth', () => ({
  getReferralPrefill: () => getReferralPrefill(),
  login: vi.fn(),
  signup: vi.fn(),
  checkReferralCode: vi.fn(),
  requestPasswordReset: vi.fn(),
  googleLoginStart: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({ setCustomer: vi.fn() }),
}));
vi.mock('@/lib/use-liquid-glass', () => ({
  useLiquidGlass: vi.fn(),
  GLASS_SUBTLE: {},
}));
vi.mock('@/lib/actions/phone-verification', () => ({
  startPhoneOtp: vi.fn(),
  resetPasswordByPhone: vi.fn(),
}));

const { default: AuthModal } = await import('../AuthModal');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  getReferralPrefill.mockReset().mockResolvedValue('ZFVZ8QLG');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(AuthModal)));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function open(referralCode?: string) {
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('polycards:auth', {
        detail: { mode: 'signup', referralCode },
      }),
    );
  });
}

function referralInput() {
  const input = document.querySelector<HTMLInputElement>(
    'input[name="referralCode"]',
  );
  if (!input) throw new Error('Signup referral input missing');
  return input;
}

describe('signup referral prefill', () => {
  it('reads the stored invitation when signup is opened after a page reload', async () => {
    await open();
    expect(referralInput().value).toBe('ZFVZ8QLG');
  });

  it('retains the invitation when the dialog is closed and reopened', async () => {
    await open('ZFVZ8QLG');
    act(() =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Close"]')
        ?.click(),
    );
    await open();
    expect(referralInput().value).toBe('ZFVZ8QLG');
  });

  it('does not overwrite a code typed while the stored invitation is loading', async () => {
    let resolve: (code: string) => void = () => {};
    getReferralPrefill.mockReturnValue(
      new Promise<string>((done) => {
        resolve = done;
      }),
    );
    await open();
    referralInput().value = 'ABCD2345';
    await act(async () => resolve('ZFVZ8QLG'));
    expect(referralInput().value).toBe('ABCD2345');
  });

  it('does not let a stale cookie response replace a newer referral link', async () => {
    let resolve: (code: string) => void = () => {};
    getReferralPrefill.mockReturnValue(
      new Promise<string>((done) => {
        resolve = done;
      }),
    );
    await open();
    await open('ABCD2345');
    await act(async () => resolve('ZFVZ8QLG'));
    expect(referralInput().value).toBe('ABCD2345');
  });

  it('keeps signup usable when the cookie read fails', async () => {
    getReferralPrefill.mockRejectedValue(new Error('unavailable'));
    await open();
    expect(referralInput().value).toBe('');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
