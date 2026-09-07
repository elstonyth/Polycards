// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The required-phone gate the account layout mounts for a password-less,
// phoneless account. No local run can drive the real OTP (Twilio is
// unconfigured in dev/CI), so these pin the wiring: no dismiss, the entry →
// code → changePhone hand-off under the 'phone-change' purpose the backend's
// first-phone branch expects, the voice-call first send, the refusal
// round-trip, and the Log out hatch.

const mocks = vi.hoisted(() => ({
  startPhoneOtp: vi.fn(),
  checkPhoneOtp: vi.fn(),
  changePhone: vi.fn(),
  logout: vi.fn(async () => {}),
  setCustomer: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
}));

vi.mock('@/lib/actions/phone-verification', () => ({
  startPhoneOtp: mocks.startPhoneOtp,
  checkPhoneOtp: mocks.checkPhoneOtp,
  changePhone: mocks.changePhone,
}));
vi.mock('@/lib/actions/auth', () => ({ logout: mocks.logout }));
vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({ setCustomer: mocks.setCustomer }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: mocks.push }),
}));

const { PhoneOnboardingModal } = await import('../PhoneOnboardingModal');

let container: HTMLDivElement;
let root: Root;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount() {
  await act(async () => {
    root.render(createElement(PhoneOnboardingModal));
  });
}

const dialog = () => container.querySelector('[role="dialog"]');
const buttons = () => [...container.querySelectorAll('button')];
const button = (text: string) =>
  buttons().find((b) => b.textContent?.trim() === text);
const tel = () =>
  container.querySelector<HTMLInputElement>('input[type="tel"]');
const codeInput = () =>
  container.querySelector<HTMLInputElement>('input[name="code"]');

// React controlled inputs ignore a plain `.value =` — go through the native
// setter so the change reaches React's onChange.
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function submit(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
  });
}

/** Entry → code step by SMS with a valid MY number; returns the code input. */
async function reachCodeStep() {
  mocks.startPhoneOtp.mockResolvedValueOnce({ ok: true });
  await mount();
  typeInto(tel()!, '012-345 6789');
  await submit(container.querySelector('form')!);
  const code = codeInput();
  expect(code).not.toBeNull();
  return code!;
}

describe('PhoneOnboardingModal (required gate)', () => {
  test('has no dismiss: no Skip control, Escape leaves it open', async () => {
    await mount();
    expect(dialog()?.textContent).toContain('Verify your phone');
    expect(buttons().map((b) => b.textContent)).not.toContain('Skip for now');
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(dialog()).not.toBeNull();
    expect(mocks.startPhoneOtp).not.toHaveBeenCalled();
  });

  test('entry → code → changePhone, then closes and refreshes', async () => {
    mocks.checkPhoneOtp.mockResolvedValueOnce({ ok: true, token: 'proof' });
    mocks.changePhone.mockResolvedValueOnce({
      ok: true,
      phone: '+60123456789',
    });
    const code = await reachCodeStep();

    // 'phone-change' is the purpose the change route verifies the proof
    // under; no channel = the backend's SMS default.
    expect(mocks.startPhoneOtp).toHaveBeenCalledWith({
      phone: '+60123456789',
      purpose: 'phone-change',
    });
    expect(dialog()?.textContent).toContain('code we sent to');
    typeInto(code, '123456');
    await submit(code.closest('form')!);

    expect(mocks.checkPhoneOtp).toHaveBeenCalledWith({
      phone: '+60123456789',
      purpose: 'phone-change',
      code: '123456',
    });
    expect(mocks.changePhone).toHaveBeenCalledWith({
      phone: '+60123456789',
      token: 'proof',
    });
    expect(dialog()).toBeNull();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  test('"Get a call instead" sends the first code by voice and says so', async () => {
    mocks.startPhoneOtp.mockResolvedValueOnce({ ok: true });
    await mount();
    typeInto(tel()!, '012-345 6789');
    await act(async () =>
      button("Can't receive SMS? Get a call instead")!.click(),
    );

    expect(mocks.startPhoneOtp).toHaveBeenCalledWith({
      phone: '+60123456789',
      purpose: 'phone-change',
      channel: 'call',
    });
    expect(codeInput()).not.toBeNull();
    // PhoneOtpStep opens on the call copy, not "code we sent".
    expect(dialog()?.textContent).toContain("We're calling");
    expect(button('Call again')).toBeDefined();
  });

  test('"Get a call instead" still validates the number first', async () => {
    await mount();
    typeInto(tel()!, '123');
    await act(async () =>
      button("Can't receive SMS? Get a call instead")!.click(),
    );
    expect(mocks.startPhoneOtp).not.toHaveBeenCalled();
    expect(
      container.querySelector('#phone-onboarding-error')?.textContent,
    ).toMatch(/valid phone number/i);
  });

  test('a changePhone refusal returns to entry with the number kept and no refresh', async () => {
    mocks.checkPhoneOtp.mockResolvedValueOnce({ ok: true, token: 'proof' });
    mocks.changePhone.mockResolvedValueOnce({
      ok: false,
      error: 'This phone number is already registered to another account.',
    });
    const code = await reachCodeStep();
    typeInto(code, '123456');
    await submit(code.closest('form')!);

    expect(dialog()).not.toBeNull();
    expect(codeInput()).toBeNull();
    expect(
      container.querySelector('#phone-onboarding-error')?.textContent,
    ).toBe('This phone number is already registered to another account.');
    // The number survives the round trip — an expired proof wants it again.
    expect(tel()?.value).toBe('012-345 6789');
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  test('a refused send is reported on the entry step, not swallowed', async () => {
    mocks.startPhoneOtp.mockResolvedValueOnce({
      ok: false,
      error: 'Could not send the code. Please try again.',
    });
    await mount();
    typeInto(tel()!, '012-345 6789');
    await submit(container.querySelector('form')!);

    expect(
      container.querySelector('#phone-onboarding-error')?.textContent,
    ).toBe('Could not send the code. Please try again.');
    expect(codeInput()).toBeNull();
    expect(dialog()).not.toBeNull();
  });

  test('Log out is the escape hatch: clears the session and leaves', async () => {
    await mount();
    await act(async () => button('Log out')!.click());
    expect(mocks.logout).toHaveBeenCalledTimes(1);
    expect(mocks.setCustomer).toHaveBeenCalledWith(null);
    expect(mocks.push).toHaveBeenCalledWith('/');
  });

  test('a stale tab (phone already saved elsewhere) is told to reload, not retry', async () => {
    mocks.checkPhoneOtp.mockResolvedValueOnce({ ok: true, token: 'proof' });
    mocks.changePhone.mockResolvedValueOnce({
      ok: false,
      error: 'Verify your current phone number before changing it.',
      needsOldPhoneProof: true,
    });
    const code = await reachCodeStep();
    typeInto(code, '123456');
    await submit(code.closest('form')!);

    expect(
      container.querySelector('#phone-onboarding-error')?.textContent,
    ).toMatch(/already saved.*reload/i);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
