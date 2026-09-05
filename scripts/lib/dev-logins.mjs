// Reads scripts/.dev-logins (gitignored KEY=VALUE) the way launch-stack.ps1
// injects it, so the QA scripts run standalone. Never prints anything.
import fs from 'node:fs';
import path from 'node:path';

export function devLogins() {
  let raw = '';
  try {
    raw = fs.readFileSync(path.resolve('scripts/.dev-logins'), 'utf8');
  } catch {
    return {};
  }
  return Object.fromEntries(
    raw
      .split(/\r?\n/)
      .map((l) => l.match(/^([A-Z_]+)=(.*)$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2].trim()]),
  );
}

/** The dev customer's login, env first, then the file. */
export function devCustomer() {
  const env = devLogins();
  return {
    email: process.env.CUST_EMAIL ?? env.CUST_EMAIL ?? 'test@polycards.app',
    password: process.env.CUST_PW ?? env.CUST_PW ?? '',
  };
}
