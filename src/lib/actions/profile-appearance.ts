'use server';

/**
 * Profile appearance server actions — photo upload + frame equip/unequip.
 *
 * The frame POST goes through the `Store` port (src/lib/store.ts) like every
 * other backend call. The photo POST cannot: it is MULTIPART, and the port's
 * transport is `sdk.client.fetch`, which JSON-stringifies a body whenever the
 * content type is JSON and cannot be handed a `FormData` with its boundary
 * intact. So it stays a raw `fetch` against MEDUSA_BACKEND_URL, building the
 * two headers itself — the one exception the pre-port transport module already
 * carved out for the same reason. It reads the JWT straight from the cookie
 * the port owns the name of (`AUTH_COOKIE`), so there is still exactly one
 * declaration of which cookie carries the session.
 */
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { MEDUSA_BACKEND_URL } from '@/lib/medusa';
import { store, type Failure } from '@/lib/store';
import { AUTH_COOKIE } from '@/lib/store-port';
import { logger } from '@/lib/logger';
import {
  friendlyError,
  friendlyFailure,
  COPY,
  RATE_LIMITED,
  UNAUTHORIZED,
  type ErrorRule,
} from '@/lib/errors';
import { UncheckedSchema } from '@/lib/data/schemas';
import { FRAME_LEVELS } from '@/lib/frame-levels';

const APPEARANCE_RULES: ErrorRule[] = [
  [/capped at 5 mb/i, 'Photo is too large — keep it under 5 MB.'],
  // The cropper exports a 512px square so this shouldn't fire — it exists so a
  // dimension rejection reads as a real reason instead of falling through to
  // "Something went wrong" (what customers actually saw before the crop step).
  [/each side/i, 'That photo is too big — try a smaller one.'],
  [/roughly square/i, 'That photo is too wide — crop it to a square first.'],
  [
    /unsupported type|match the declared|valid image|dimensions|at least|animated/i,
    "That file doesn't look like a usable photo — try a JPG, PNG, or WebP.",
  ],
  [/unlocks at level/i, 'That frame is still locked — keep leveling!'],
  [/no frame image is configured/i, 'That frame isn’t available yet.'],
  // Both transport rules stay, and stay HERE rather than moving to the shared
  // tier: the probes are the shared ones (lib/errors.ts) but the sentences are
  // not ("wait a moment", not "give it a moment"; "log in again", not "log in
  // first"). They also have to stay in a RULES table rather than become a
  // `kind` branch, because the multipart avatar upload below never goes
  // through the `Store` port — it has no `Failure`, only a raw message.
  [RATE_LIMITED, 'Too many requests — wait a moment and try again.'],
  [UNAUTHORIZED, 'Please log in again.'],
];
const FALLBACK = COPY.generic;
const LOGIN_FIRST = 'Please log in first.';

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
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  if (!token) return { ok: false, error: LOGIN_FIRST };
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
  if (level !== null && !(FRAME_LEVELS as readonly number[]).includes(level)) {
    return { ok: false, error: 'Invalid frame.' };
  }
  // The response is not read — a 2xx IS the answer.
  const r = await store.post('/store/profile/frame', UncheckedSchema, {
    level,
  });
  if (!r.ok) return { ok: false, error: frameError(r) };
  revalidatePath('/me');
  return { ok: true };
}

/** No cookie at all (the call never left — `status` is undefined) keeps the
 *  logged-out sentence; anything the backend actually said goes through
 *  APPEARANCE_RULES, the same table the upload's own refusals use. */
function frameError(f: Failure): string {
  if (f.kind === 'unauthenticated' && f.status === undefined) {
    return LOGIN_FIRST;
  }
  return friendlyFailure(f, APPEARANCE_RULES, FALLBACK);
}
