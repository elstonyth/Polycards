// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { UnrecognizedActionError } from 'next/dist/client/components/unrecognized-action-error';

// A deploy rotates server action IDs; a tab still running the previous build
// then gets UnrecognizedActionError from every action call. Retrying can never
// work there — only a reload fetches the new IDs — so the form must say so
// instead of the generic "try again" (prod, 2026-09-23: one user tapped Log in
// a dozen times against a stale tab).
const login = vi.fn();
vi.mock('@/lib/actions/auth', () => ({
  login: (...args: unknown[]) => login(...args),
  signup: vi.fn(),
  checkReferralCode: vi.fn(),
  requestPasswordReset: vi.fn(),
  googleLoginStart: vi.fn(),
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({ setCustomer: vi.fn() }),
}));
vi.mock('@/lib/actions/phone-verification', () => ({
  startPhoneOtp: vi.fn(),
  resetPasswordByPhone: vi.fn(),
}));

const { default: AuthForm } = await import('../AuthForm');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  login.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(AuthForm, { mode: 'login', onSwitchMode: vi.fn() }),
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function submitLogin() {
  const form = container.querySelector('form');
  if (!form) throw new Error('Login form missing');
  form.querySelector<HTMLInputElement>('input[name="email"]')!.value =
    'collector@example.com';
  form.querySelector<HTMLInputElement>('input[name="password"]')!.value =
    'placeholder';
  await act(async () => {
    form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
  });
  return document.getElementById('auth-form-error')?.textContent;
}

describe('login against a newer deployment', () => {
  it('asks for a refresh when the server no longer knows the action', async () => {
    login.mockRejectedValue(
      new UnrecognizedActionError('Server Action "40cf25bb" was not found'),
    );
    expect(await submitLogin()).toBe(
      'Polycards was just updated. Refresh the page and try again.',
    );
  });

  it('keeps the generic copy for any other transport failure', async () => {
    login.mockRejectedValue(new Error('Failed to fetch'));
    expect(await submitLogin()).toBe('Something went wrong. Please try again.');
  });
});
