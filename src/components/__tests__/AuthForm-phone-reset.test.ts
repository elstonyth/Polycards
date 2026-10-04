// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Forgot-password-by-phone ends with a single-use password-reset token. A URL
// would carry it into request logs, browser history, Referer headers and error
// breadcrumbs, so the token stays in the modal's state and the new-password
// step renders in place. Navigation is observed through @/lib/navigation, the
// seam AuthForm uses for every full-page load.
const resetPassword = vi.fn();
const resetPasswordByPhone = vi.fn();
const leaveFor = vi.fn();
vi.mock('@/lib/actions/auth', () => ({
  login: vi.fn(),
  signup: vi.fn(),
  checkReferralCode: vi.fn(),
  requestPasswordReset: vi.fn(),
  googleLoginStart: vi.fn(),
  resetPassword: (...args: unknown[]) => resetPassword(...args),
}));
vi.mock('@/lib/actions/phone-verification', () => ({
  startPhoneOtp: vi.fn(async () => ({ ok: true, channel: 'sms' })),
  checkPhoneOtp: vi.fn(async () => ({ ok: true, token: 'phone-proof' })),
  resetPasswordByPhone: (...args: unknown[]) => resetPasswordByPhone(...args),
}));
vi.mock('@/lib/phone-verification', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/phone-verification')>()),
  PHONE_VERIFICATION_REQUIRED: true,
}));
vi.mock('@/lib/navigation', () => ({
  leaveFor: (url: string) => leaveFor(url),
  reloadPage: vi.fn(),
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({ setCustomer: vi.fn() }),
}));

const { default: AuthForm } = await import('../AuthForm');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const RESET_TOKEN = 'reset-token-from-the-backend';

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  resetPassword.mockReset();
  resetPasswordByPhone.mockReset();
  leaveFor.mockReset();
  resetPasswordByPhone.mockResolvedValue({
    ok: true,
    token: RESET_TOKEN,
    maskedEmail: 'o****@test.dev',
  });
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

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`No "${label}" button`);
  return found;
}

/** The one form on screen, with `values` written into its named inputs. */
async function submitForm(values: Record<string, string>) {
  const form = container.querySelector('form');
  if (!form) throw new Error('No form on screen');
  for (const [name, value] of Object.entries(values))
    form.querySelector<HTMLInputElement>(`input[name="${name}"]`)!.value =
      value;
  await act(async () => {
    form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
  });
}

/** Login → forgot → phone → code, ending on the step after a verified code. */
async function verifyPhone() {
  await act(async () => button('Forgot password?').click());
  await act(async () => button('Use phone number instead').click());
  await submitForm({ phone: '+60107667787' });
  await submitForm({ code: '000000' });
  expect(resetPasswordByPhone).toHaveBeenCalledWith({ token: 'phone-proof' });
}

describe('forgot password by phone', () => {
  it('sets the new password inside the modal, never through a URL', async () => {
    resetPassword.mockResolvedValue({ ok: true });
    await verifyPhone();

    expect(leaveFor).not.toHaveBeenCalled();
    expect(container.textContent).toContain('o****@test.dev');

    await submitForm({
      password: 'NewPassword123!',
      confirmPassword: 'NewPassword123!',
    });

    expect(resetPassword).toHaveBeenCalledWith({
      token: RESET_TOKEN,
      password: 'NewPassword123!',
    });
    expect(container.textContent).toContain('Password updated');
    expect(leaveFor).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain(RESET_TOKEN);
  });

  it('catches a mismatched confirmation before spending the token', async () => {
    await verifyPhone();

    await submitForm({
      password: 'NewPassword123!',
      confirmPassword: 'NewPassword124!',
    });

    expect(resetPassword).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Passwords don't match.");
  });

  it('shows the reset refusal and stays on the step', async () => {
    resetPassword.mockResolvedValue({
      ok: false,
      error:
        'This reset link is invalid or has expired. Request a new one and try again.',
    });
    await verifyPhone();

    await submitForm({
      password: 'NewPassword123!',
      confirmPassword: 'NewPassword123!',
    });

    expect(container.textContent).toContain('has expired');
    expect(container.querySelector('input[name="password"]')).not.toBeNull();
    expect(leaveFor).not.toHaveBeenCalled();
  });
});
