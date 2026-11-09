// The operator's authenticator app, for the two-step admin sign-in (#996):
// every admin login answers a 6-digit code after the password. The secret is
// the one seed:e2e set up (it prints `totp_secret=…`; e2e.yml passes it on as
// PW_ADMIN_TOTP_SECRET). The code math is the backend's own helper.
import { totpCode } from '../../../backend/packages/api/src/utils/totp-code';
import { ADMIN_TOTP_SECRET } from './constants';

const STEP_MS = 30_000;
let lastStep = -1;

/** A code from a 30-second step this process has not answered with yet: the
 *  backend takes each code once per login, so a second sign-in in the same
 *  step waits for the next one (at most ~30 s). */
export async function freshAdminCode(): Promise<string> {
  if (!ADMIN_TOTP_SECRET) {
    throw new Error(
      'PW_ADMIN_TOTP_SECRET is not set — the admin sign-in asks for an authenticator code. ' +
        'seed:e2e prints it as totp_secret=… (see tests/e2e/README.md).',
    );
  }
  while (Math.floor(Date.now() / STEP_MS) <= lastStep) {
    await new Promise((r) => setTimeout(r, 1_000));
  }
  const now = Date.now();
  lastStep = Math.floor(now / STEP_MS);
  return totpCode(ADMIN_TOTP_SECRET, now);
}
