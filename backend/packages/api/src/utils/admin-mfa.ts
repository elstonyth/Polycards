import { hkdfSync } from 'node:crypto';

// Admin two-step sign-in (owner, 2026-11-07): every admin login uses an
// authenticator app (Google Authenticator, Microsoft Authenticator, Ente Auth
// and the like) through Medusa's built-in `totp` MFA provider: standard TOTP,
// SHA-1, 6 digits, a new code every 30 seconds.

/** The name the authenticator app shows above the code. */
export const ADMIN_MFA_ISSUER = 'Polycards Admin';

/**
 * The key the auth module encrypts each saved authenticator secret with (it
 * hashes this to an AES-256-GCM key). Derived from the JWT secret with HKDF, as
 * the assistant's key vault is, so no new deploy secret is needed.
 *
 * Rotating JWT_SECRET makes every saved authenticator unreadable, and every
 * admin with one can no longer sign in. After a rotation, soft-delete the rows
 * in auth_mfa_factor and auth_mfa_recovery_code; each admin then sets up again.
 */
export const adminMfaEncryptionKey = (jwtSecret: string): string =>
  Buffer.from(
    hkdfSync('sha256', jwtSecret, 'polycards-admin-mfa', 'totp-secret-v1', 32),
  ).toString('hex');
