#!/usr/bin/env node
// Generate OUR A3Pay merchant RSA key pair locally.
//
// A3Pay's onboarding message points at an online RSA generator. Do not use it:
// a private key generated on someone else's web page is a key someone else
// may have seen. This script generates the pair on this machine instead.
//
//   node scripts/a3pay-keygen.mjs [--bits 2048] [--force]
//
// - The PRIVATE key (PKCS#8, bare base64 — the format A3Pay's samples import)
//   is written into backend/packages/api/.env as A3PAY_MERCHANT_PRIVATE_KEY.
//   It is never printed. An existing value is kept unless --force, because
//   replacing a key A3Pay has already registered breaks every signed call.
// - The PUBLIC key (X.509 SubjectPublicKeyInfo, bare base64 — what A3Pay's
//   ImportSubjectPublicKeyInfo / X509EncodedKeySpec expect) is printed and
//   saved to docs/payments/a3pay-merchant-public-key.txt. Public by design:
//   it is what gets sent to A3Pay.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, 'backend', 'packages', 'api', '.env');
const publicPath = join(
  root,
  'docs',
  'payments',
  'a3pay-merchant-public-key.txt',
);

const args = process.argv.slice(2);
const bitsArg = args.indexOf('--bits');
const bits = bitsArg >= 0 ? Number(args[bitsArg + 1]) : 2048;
const force = args.includes('--force');
if (![1024, 2048, 4096].includes(bits)) {
  console.error('--bits must be 1024, 2048 or 4096');
  process.exit(1);
}

const env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
const line = /^A3PAY_MERCHANT_PRIVATE_KEY=.*$/m;
if (line.test(env) && !force) {
  console.error(
    'A3PAY_MERCHANT_PRIVATE_KEY is already set in backend/packages/api/.env — ' +
      'kept. Re-run with --force only if A3Pay has NOT registered its public key yet.',
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

const entry = `A3PAY_MERCHANT_PRIVATE_KEY=${privateB64}`;
const next = line.test(env)
  ? env.replace(line, entry)
  : `${env}${env && !env.endsWith('\n') ? '\n' : ''}${entry}\n`;
writeFileSync(envPath, next);
writeFileSync(publicPath, `${publicB64}\n`);

console.log(`RSA-${bits} merchant key pair generated.`);
console.log('Private key: written to backend/packages/api/.env (not printed).');
console.log(
  `Public key (send this to A3Pay), also saved to docs/payments/a3pay-merchant-public-key.txt:\n`,
);
console.log(publicB64);
