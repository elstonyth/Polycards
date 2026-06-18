import { describe, it, expect } from 'vitest';
import { parseMuted } from '@/lib/use-sound';

describe('parseMuted', () => {
  it('treats "1" as muted', () => {
    expect(parseMuted('1')).toBe(true);
  });
  it('treats anything else (incl. null) as unmuted — default unmuted', () => {
    expect(parseMuted('0')).toBe(false);
    expect(parseMuted(null)).toBe(false);
    expect(parseMuted('')).toBe(false);
    expect(parseMuted('true')).toBe(false);
  });
});
