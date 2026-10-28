import { isOwnPublicKey } from '../../modules/packs/a3pay';
import { A3PAY_FAMILY, type A3payKind } from '../../modules/packs/a3pay-client';
import { alertOps } from '../../modules/packs/ops-alert';

/**
 * A message that DECRYPTED with our AES key but whose RSA signature did not
 * verify. Not routine noise: either A3Pay signs a different string than the
 * handbook says (then EVERY real callback is refused and deposits settle only
 * through the 1-minute requery, payout verifications refuse every payout), or
 * someone holds our AES key and is forging. Either way a human must look, so
 * this alerts ops — muted for an hour so a retry storm is one message.
 * Messages that do not even decrypt stay a log line (junk from the internet).
 *
 * Given the keys, it first rules out the one cause we can see from here: their
 * key slot holding our own public key (isOwnPublicKey) — then the alert names
 * the env var to fix instead of pointing at a leak.
 */
export function signatureMismatchAlert(
  scope: { resolve: <T>(key: string) => T },
  error: unknown,
  what: string,
  kind: A3payKind = 'a3pay',
  keys?: { publicKey: string; privateKey: string },
): void {
  const message = error instanceof Error ? error.message : String(error);
  if (!/signature verification failed/i.test(message)) return;
  const { label, envPrefix } = A3PAY_FAMILY[kind];
  void alertOps(
    scope,
    `${kind}-signature-mismatch`,
    keys && isOwnPublicKey(keys.publicKey, keys.privateKey)
      ? `${label} ${what} refused: ${envPrefix}_PUBLIC_KEY is the public half of our own ${envPrefix}_MERCHANT_PRIVATE_KEY, so no ${label} signature can verify. Set it to ${label}'s platform public key and redeploy — until then every callback is refused (deposits still settle via the 1-minute requery).`
      : `${label} ${what}: it decrypted with our AES key but its signature did not verify. Either ${label} signs a different string than its handbook (every callback is being refused — deposits still settle via the 1-minute requery) or our AES key has leaked. Check the backend logs for "[${kind}] rejected".`,
    { muteMs: 60 * 60 * 1000 },
  );
}
