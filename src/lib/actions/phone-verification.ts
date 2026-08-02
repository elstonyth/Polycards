'use server';

/**
 * Phone-OTP server actions. Thin proxies onto the backend's
 * /store/phone-verification/* routes — running server-side keeps the
 * publishable-key transport consistent with every other action and lets the
 * backend's IP rate limiter see the real client via x-forwarded-for.
 */
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { getAuthToken } from '@/lib/data/customer';
import { normalizePhone } from '@/lib/profile-validation';
import type { PhoneOtpPurpose } from '@/lib/phone-verification';

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

// 429s carry a useful retry message; keep it, genericize everything else.
const messageOf = (error: unknown, fallback: string): string => {
  const msg = error instanceof Error ? error.message : '';
  return /try again in \d+s/i.test(msg) ? msg : fallback;
};

export async function startPhoneOtp(input: {
  phone: string;
  purpose: PhoneOtpPurpose;
}): Promise<{ ok: true } | Fail> {
  const phone = normalizePhone(input.phone);
  if (!phone)
    return fail('Please enter a valid phone number for the selected country.');
  try {
    await sdk.client.fetch('/store/phone-verification/start', {
      method: 'POST',
      body: { phone, purpose: input.purpose },
    });
    return { ok: true };
  } catch (error) {
    logger.error('[phone-otp] start failed:', error);
    return fail(messageOf(error, 'Could not send the code. Please try again.'));
  }
}

export async function checkPhoneOtp(input: {
  phone: string;
  purpose: PhoneOtpPurpose;
  code: string;
}): Promise<{ ok: true; token: string } | Fail> {
  const phone = normalizePhone(input.phone);
  if (!phone)
    return fail('Please enter a valid phone number for the selected country.');
  if (!/^\d{4,10}$/.test(input.code))
    return fail('Enter the code from the SMS.');
  try {
    const { token } = await sdk.client.fetch<{ token: string }>(
      '/store/phone-verification/check',
      {
        method: 'POST',
        body: { phone, purpose: input.purpose, code: input.code },
      },
    );
    return { ok: true, token };
  } catch (error) {
    logger.error('[phone-otp] check failed:', error);
    return fail(messageOf(error, 'Invalid or expired code.'));
  }
}

export async function changePhone(input: {
  phone: string;
  token: string;
}): Promise<{ ok: true; phone: string } | Fail> {
  const phone = normalizePhone(input.phone);
  if (!phone)
    return fail('Please enter a valid phone number for the selected country.');
  // Authed route — same cookie→Bearer idiom as setAvatarFrame in
  // src/lib/actions/profile-appearance.ts (a custom Mercur route, so this
  // can't go through sdk.store.customer.update like updateCustomerProfile).
  const authToken = await getAuthToken();
  if (!authToken) return fail('Please log in first.');
  try {
    const { customer } = await sdk.client.fetch<{
      customer: { phone: string };
    }>('/store/phone-verification/change', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: { phone, token: input.token },
    });
    return { ok: true, phone: customer.phone };
  } catch (error) {
    logger.error('[phone-otp] change failed:', error);
    return fail('Could not update your phone number. Please try again.');
  }
}

export async function resetPasswordByPhone(input: {
  token: string;
}): Promise<{ ok: true; token: string; maskedEmail: string } | Fail> {
  try {
    const data = await sdk.client.fetch<{ token: string; maskedEmail: string }>(
      '/store/phone-verification/password-reset',
      { method: 'POST', body: { token: input.token } },
    );
    return { ok: true, ...data };
  } catch (error) {
    logger.error('[phone-otp] reset exchange failed:', error);
    return fail(
      messageOf(error, 'Could not verify this phone. Reset by email instead.'),
    );
  }
}
