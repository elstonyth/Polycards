import { alertOps } from '../../modules/packs/ops-alert';

/**
 * A message that DECRYPTED with our AES key but whose RSA signature did not
 * verify. Not routine noise: either A3Pay signs a different string than the
 * handbook says (then EVERY real callback is refused and deposits settle only
 * through the 1-minute requery, payout verifications refuse every payout), or
 * someone holds our AES key and is forging. Either way a human must look, so
 * this alerts ops — muted for an hour so a retry storm is one message.
 * Messages that do not even decrypt stay a log line (junk from the internet).
 */
export function signatureMismatchAlert(
  scope: { resolve: <T>(key: string) => T },
  error: unknown,
  what: string,
): void {
  const message = error instanceof Error ? error.message : String(error);
  if (!/signature verification failed/i.test(message)) return;
  void alertOps(
    scope,
    'a3pay-signature-mismatch',
    `An A3Pay ${what} decrypted with our AES key but its signature did not verify. Either A3Pay signs a different string than its handbook (every callback is being refused — deposits still settle via the 1-minute requery) or our AES key has leaked. Check the backend logs for "[a3pay] rejected".`,
    { muteMs: 60 * 60 * 1000 },
  );
}
