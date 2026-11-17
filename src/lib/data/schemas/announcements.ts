import { z } from './zod';
import { hasUnsafeUrlChar } from '@/lib/unsafe-url-char';
import { droppableArray } from './shared';

/** Whitespace, `\` or a control character: a browser strips or reinterprets
 *  them (`\` reads as `/`), so a URL carrying one is not the URL a check saw. */
export { hasUnsafeUrlChar };

/** One slide of the storefront announcement popup (spec 2026-10-06 §5). */
export const AnnouncementSchema = z.looseObject({
  id: z.string(),
  // Absolute http(s) only, mirroring the backend write gate. A relative src
  // with a `?` throws inside next/image and would take the page to
  // global-error, so this is checked again here rather than trusted.
  image_url: z
    .string()
    .refine((s) => /^https?:\/\/[^/]/i.test(s) && !hasUnsafeUrlChar(s)),
  title: z.string().nullable(),
  link_url: z.string().nullable(),
  /** Part of the dismissal key — an edited slide shows again. */
  updated_at: z.string(),
});
export type Announcement = z.infer<typeof AnnouncementSchema>;

/** GET /store/announcements — the live set, already in carousel order. A slide
 *  that fails the schema is DROPPED, not allowed to blank the others. */
export const AnnouncementsSchema = z.looseObject({
  announcements: droppableArray(AnnouncementSchema),
});

/** GET /store/profiles/me — `{ handle }`. */
export const ProfileHandleSchema = z.looseObject({ handle: z.string() });

/** GET /store/customers/me/account — the required-phone gate's facts plus the
 *  account-tree policy.
 *  `hasPassword` is REQUIRED here on purpose: data/customer.ts answers `true`
 *  for anything it cannot read, and a body missing the field would otherwise
 *  read as `false` — raising the phone gate on an account that HAS a password,
 *  which it can never complete.
 *  `policy` is the partner-group block (spec 2026-09-09) — OPTIONAL so a
 *  deploy-skew backend without it still parses; the consumer defaults every
 *  flag to false (no exemption, no block), which is the pre-feature behaviour. */
export const AccountInfoSchema = z.looseObject({
  hasPassword: z.boolean(),
  // Real name + phone lock (spec 2026-10-06). OPTIONAL for deploy skew: an
  // absent field reads as "unknown", which raises no gate and offers no
  // phone edit (see getAccountInfo).
  realName: z.string().nullable().optional(),
  phoneVerified: z.boolean().optional(),
  policy: z
    .looseObject({
      partner: z.boolean(),
      withdrawals_blocked: z.boolean(),
      verification_exempt: z.boolean(),
    })
    .optional(),
});

/** POST /store/customers/me/real-name — the stored (normalized) name. */
export const RealNameSchema = z.looseObject({ real_name: z.string() });

/** GET /store/customers/me/real-name — the name on file, or null. */
export const RealNameReadSchema = z.looseObject({
  real_name: z.string().nullable(),
});
