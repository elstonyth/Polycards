'use server';

/**
 * Profile appearance server actions — photo upload + frame equip/unequip.
 * The photo POST is multipart, so it uses raw fetch (sdk.client.fetch
 * JSON-encodes bodies); the JWT stays in the httpOnly cookie, read server-side.
 */
import { revalidatePath } from 'next/cache';
import { MEDUSA_BACKEND_URL, sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { getAuthToken } from '@/lib/data/customer';
import { friendlyError, type ErrorRule } from '@/lib/errors';

const APPEARANCE_RULES: ErrorRule[] = [
  [/capped at 5 mb/i, 'Photo is too large — keep it under 5 MB.'],
  [
    /unsupported type|match the declared|valid image|dimensions|at least|animated/i,
    "That file doesn't look like a usable photo — try a JPG, PNG, or WebP.",
  ],
  [/unlocks at level/i, 'That frame is still locked — keep leveling!'],
  [/no frame image is configured/i, 'That frame isn’t available yet.'],
  [
    /too many|rate.?limit|429/i,
    'Too many requests — wait a moment and try again.',
  ],
  [/unauthorized|not authenticated|401/i, 'Please log in again.'],
];
const FALLBACK = 'Something went wrong. Please try again.';

export type AppearanceResult = { ok: true } | { ok: false; error: string };

/** Upload a new profile photo (field name 'file' in the incoming FormData). */
export async function uploadAvatar(
  formData: FormData,
): Promise<AppearanceResult> {
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'Pick an image first.' };
  }
  if (file.size > 5 * 1024 * 1024) {
    return { ok: false, error: 'Photo is too large — keep it under 5 MB.' };
  }
  const token = await getAuthToken();
  if (!token) return { ok: false, error: 'Please log in first.' };
  try {
    const body = new FormData();
    body.append('files', file);
    const res = await fetch(`${MEDUSA_BACKEND_URL}/store/profile/avatar`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-publishable-api-key':
          process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? '',
      },
      body,
    });
    if (!res.ok) {
      const detail =
        ((await res.json().catch(() => null)) as { message?: string } | null)
          ?.message ?? `Upload failed (${res.status}).`;
      return {
        ok: false,
        error: friendlyError(new Error(detail), APPEARANCE_RULES, FALLBACK),
      };
    }
    revalidatePath('/me');
    return { ok: true };
  } catch (error) {
    logger.error('[appearance] avatar upload failed:', error);
    return {
      ok: false,
      error: friendlyError(error, APPEARANCE_RULES, FALLBACK),
    };
  }
}

/** Equip (milestone level) or unequip (null) an avatar frame. */
export async function setAvatarFrame(
  level: number | null,
): Promise<AppearanceResult> {
  if (
    level !== null &&
    (!Number.isInteger(level) || level < 10 || level > 100 || level % 10 !== 0)
  ) {
    return { ok: false, error: 'Invalid frame.' };
  }
  const token = await getAuthToken();
  if (!token) return { ok: false, error: 'Please log in first.' };
  try {
    await sdk.client.fetch('/store/profile/frame', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: { level },
    });
    revalidatePath('/me');
    return { ok: true };
  } catch (error) {
    logger.error('[appearance] frame set failed:', error);
    return {
      ok: false,
      error: friendlyError(error, APPEARANCE_RULES, FALLBACK),
    };
  }
}
