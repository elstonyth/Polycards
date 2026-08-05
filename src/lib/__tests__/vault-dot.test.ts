import { describe, expect, test } from 'vitest';
import { seenKey, shouldShowDot } from '@/lib/vault-dot';

const OLD = '2026-08-01T00:00:00.000Z';
const NEW = '2026-08-04T00:00:00.000Z';

describe('seenKey', () => {
  test('namespaces the key by customer id', () => {
    expect(seenKey('cus_a')).toBe('polycards.vault_seen_at:cus_a');
  });

  test('gives two customers different keys', () => {
    // TopUpProvider's balance leak was exactly this failure: an untagged value
    // handed account B whatever account A had left behind.
    expect(seenKey('cus_a')).not.toBe(seenKey('cus_b'));
  });
});

describe('shouldShowDot', () => {
  test('shows when there is an event and no stamp yet', () => {
    expect(shouldShowDot(NEW, null)).toBe(true);
  });

  test('hides when the stamp matches the newest event', () => {
    expect(shouldShowDot(NEW, NEW)).toBe(false);
  });

  test('shows when the stamp is older than the newest event', () => {
    expect(shouldShowDot(NEW, OLD)).toBe(true);
  });

  test('hides when the stamp is ahead of the newest event (clock skew)', () => {
    expect(shouldShowDot(OLD, NEW)).toBe(false);
  });

  test('hides when the vault is empty', () => {
    expect(shouldShowDot(null, OLD)).toBe(false);
    expect(shouldShowDot(null, null)).toBe(false);
  });

  test('shows on an unparseable stamp — degrade toward showing', () => {
    // A corrupt stamp costs one extra tab tap and self-heals on the next visit.
    // Hiding instead would silently swallow real arrivals forever.
    expect(shouldShowDot(NEW, 'not-a-date')).toBe(true);
  });

  test('hides on an unparseable event — never show a dot we cannot justify', () => {
    expect(shouldShowDot('not-a-date', null)).toBe(false);
  });
});
