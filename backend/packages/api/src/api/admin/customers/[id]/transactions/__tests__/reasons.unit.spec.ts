import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREDIT_REASONS, parseReasons } from '../reasons';

describe('wallet list reason filter', () => {
  it('reads a comma list, absent or blank as every row', () => {
    expect(parseReasons('topup,cashout')).toEqual(['topup', 'cashout']);
    expect(parseReasons(' topup , topup ')).toEqual(['topup']);
    expect(parseReasons(undefined)).toBeNull();
    expect(parseReasons('')).toBeNull();
  });

  it('refuses an unknown reason or a repeated parameter', () => {
    expect(parseReasons('topup,refund')).toBe('invalid');
    expect(parseReasons('topup,')).toBe('invalid');
    expect(parseReasons(['topup', 'cashout'])).toBe('invalid');
  });

  // The model's enum is the source of truth: a reason added there and not
  // here would be unfilterable, one removed would 400 nothing.
  it('lists exactly the model enum', () => {
    const model = readFileSync(
      join(
        __dirname,
        '../../../../../../modules/packs/models/credit-transaction.ts',
      ),
      'utf8',
    );
    const block = model.slice(
      model.indexOf('reason: model.enum(['),
      model.indexOf(']),', model.indexOf('reason: model.enum([')),
    );
    const enumValues = [...block.matchAll(/^\s+'([a-z_]+)',?$/gm)].map(
      (m) => m[1],
    );
    expect(enumValues.length).toBeGreaterThan(5);
    expect([...enumValues].sort()).toEqual([...CREDIT_REASONS].sort());
  });
});
