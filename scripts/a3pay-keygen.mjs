#!/usr/bin/env node
// Generate OUR merchant RSA key pair locally, for A3Pay or for GlobePay365
// (the same platform, so the same key format).
//
// Both onboarding messages point at an online RSA generator. Do not use it:
// a private key generated on someone else's web page is a key someone else
// may have seen. This script generates the pair on this machine instead.
//
//   node scripts/a3pay-keygen.mjs [--gateway a3pay|gp365] [--bits 2048]
//                                 [--env-file <path>] [--public-file <path>]
//                                 [--force]
//
// - The PRIVATE key (PKCS#8, bare base64 — the format their samples import)
//   is written into backend/packages/api/.env (or --env-file) as
//   A3PAY_MERCHANT_PRIVATE_KEY / GP365_MERCHANT_PRIVATE_KEY. It is never
//   printed. An existing value is kept unless --force, because replacing a
//   key the gateway has already registered breaks every signed call.
// - The PUBLIC key (X.509 SubjectPublicKeyInfo, bare base64 — what their
//   ImportSubjectPublicKeyInfo / X509EncodedKeySpec expect) is printed and
//   saved to docs/payments/<gateway>-merchant-public-key.txt (or
//   --public-file, e.g. a production pair beside a staging one). Public by
//   design: it is what gets sent to the gateway.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const gateway = argValue('--gateway') ?? 'a3pay';
const GATEWAYS = {
  a3pay: { label: 'A3Pay', envName: 'A3PAY_MERCHANT_PRIVATE_KEY' },
  gp365: { label: 'GlobePay365', envName: 'GP365_MERCHANT_PRIVATE_KEY' },
};
if (!Object.hasOwn(GATEWAYS, gateway)) {
  console.error('--gateway must be a3pay or gp365');
  process.exit(1);
}
const { label, envName } = GATEWAYS[gateway];
const envPath =
  argValue('--env-file') ?? join(root, 'backend', 'packages', 'api', '.env');
const publicPath =
  argValue('--public-file') ??
  join(root, 'docs', 'payments', `${gateway}-merchant-public-key.txt`);

const bitsArg = args.indexOf('--bits');
const bits = bitsArg >= 0 ? Number(args[bitsArg + 1]) : 2048;
const force = args.includes('--force');
if (![1024, 2048, 4096].includes(bits)) {
  console.error('--bits must be 1024, 2048 or 4096');
  process.exit(1);
}

const env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
const line = new RegExp(`^${envName}=.*$`, 'm');
if (line.test(env) && !force) {
  console.error(
    `${envName} is already set in ${envPath} — kept. Re-run with --force ` +
      `only if ${label} has NOT registered its public key yet.`,
  );
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: bits,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'der' },
});
const privateB64 = privateKey.toString('base64');
const publicB64 = publicKey.toString('base64');

const entry = `${envName}=${privateB64}`;
const next = line.test(env)
  ? env.replace(line, () => entry)
  : `${env}${env && !env.endsWith('\n') ? '\n' : ''}${entry}\n`;
writeFileSync(envPath, next);
writeFileSync(publicPath, `${publicB64}\n`);

console.log(`RSA-${bits} merchant key pair generated.`);
console.log(`Private key: written to ${envPath} as ${envName} (not printed).`);
console.log(
  `Public key (send this to ${label}), also saved to ${publicPath}:\n`,
);
console.log(publicB64);
