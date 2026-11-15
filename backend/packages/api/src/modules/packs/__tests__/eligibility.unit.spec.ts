import {
  BOARD_FETCH_N,
  BOARD_TOP_N,
  COIN_FLIP_REFUSAL,
  disabledAccountSql,
  mayPlay,
  playRefusal,
  realGroupMemberSql,
  topShown,
  type PlayFacts,
} from '../eligibility';
import { EMPTY_GROUP_POLICY } from '../group-policy';
import { NO_TOPUP_MESSAGE } from '../withdrawable';
import type PacksModuleService from '../service';

const ok: PlayFacts = {
  disabled: false,
  frozen: false,
  hasTopup: true,
  playthroughRemaining: 0,
  group: null,
};
const plain = EMPTY_GROUP_POLICY; // a real group that is not a partner group
const rebate = { ...EMPTY_GROUP_POLICY, partner_rate_bp: 300 };
const blocked = { ...rebate, withdrawals_blocked: true };

describe('playRefusal', () => {
  it.each<[string, Partial<PlayFacts>, string | null, string | null]>([
    // label, facts, coin_flip, lucky_draw
    ['eligible, zero balance', {}, null, null],
    ['disabled', { disabled: true }, 'unavailable', 'unavailable'],
    ['disabled beats every other refusal', { disabled: true, frozen: true, hasTopup: false }, 'unavailable', 'unavailable'],
    ['frozen', { frozen: true }, 'frozen', null],
    ['no top-up, no group', { hasTopup: false }, 'no_topup', 'no_topup'],
    ['no top-up beats playthrough', { hasTopup: false, playthroughRemaining: 5 }, 'no_topup', 'no_topup'],
    ['playthrough left', { playthroughRemaining: 0.01 }, 'playthrough', null],
    ['playthrough NaN', { playthroughRemaining: NaN }, 'playthrough', null],
    ['playthrough +Infinity', { playthroughRemaining: Infinity }, 'playthrough', null],
    ['playthrough -Infinity', { playthroughRemaining: -Infinity }, 'playthrough', null],
    ['playthrough negative', { playthroughRemaining: -1 }, null, null],
    // Any real group skips the top-up; the playthrough still holds where withdrawals are allowed.
    ['plain group, no top-up', { group: plain, hasTopup: false }, null, null],
    ['partner group that may withdraw, no top-up', { group: rebate, hasTopup: false }, null, null],
    ['partner group that may withdraw, playthrough left', { group: rebate, playthroughRemaining: 0.01 }, 'playthrough', null],
    ['plain group, frozen', { group: plain, frozen: true }, 'frozen', null],
    // A withdrawal-blocked group can never cash out, so only the freeze (and disabled) still apply.
    ['withdrawal-blocked group, no top-up, playthrough left', { group: blocked, hasTopup: false, playthroughRemaining: 5 }, null, null],
    ['withdrawal-blocked group, NaN playthrough', { group: blocked, playthroughRemaining: NaN }, null, null],
    ['withdrawal-blocked group, frozen', { group: blocked, frozen: true }, 'frozen', null],
    ['withdrawal-blocked group, disabled', { group: blocked, disabled: true }, 'unavailable', 'unavailable'],
  ])('%s → coin flip %s, lucky draw %s', (_label, facts, coin, lucky) => {
    expect(playRefusal('coin_flip', { ...ok, ...facts })).toBe(coin);
    expect(playRefusal('lucky_draw', { ...ok, ...facts })).toBe(lucky);
  });
});

describe('COIN_FLIP_REFUSAL', () => {
  it('keeps the texts coin flip has always thrown', () => {
    expect(COIN_FLIP_REFUSAL).toEqual({
      unavailable: 'This account is unavailable.',
      frozen: 'Coin flips are unavailable while your account is under review.',
      no_topup: NO_TOPUP_MESSAGE,
      playthrough: 'Complete your deposit playthrough before flipping a card.',
    });
  });
});

describe('topShown', () => {
  const rows = (ids: string[]) => ids.map((id) => ({ id }));
  const ids = (r: { id: string }[]) => r.map((x) => x.id);
  const twenty = Array.from({ length: 20 }, (_, i) => `c${i + 1}`);

  it('drops hidden rows and fills the board from below', () => {
    const r = topShown(rows(twenty), new Set(['c2', 'c5']), (x) => x.id);
    expect(ids(r.shown)).toEqual(['c1', 'c3', 'c4', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11', 'c12']);
    expect(r.hiddenAboveCut).toBe(2);
  });

  it('counts only the hidden rows passed before the board filled', () => {
    // c12 is hidden right after the 10th shown row (c11), c15 further down: neither is above the cut.
    const r = topShown(rows(twenty), new Set(['c3', 'c12', 'c15']), (x) => x.id);
    expect(ids(r.shown)).toEqual(['c1', 'c2', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11']);
    expect(r.hiddenAboveCut).toBe(1);
  });

  it('renders a short board honestly, never an error', () => {
    const r = topShown(rows(['a', 'b', 'c']), new Set(['b']), (x) => x.id);
    expect(ids(r.shown)).toEqual(['a', 'c']);
    expect(r.hiddenAboveCut).toBe(1);
    expect(topShown([], new Set(), (x: { id: string }) => x.id)).toEqual({ shown: [], hiddenAboveCut: 0 });
  });

  it('takes another length, and keeps the board and the over-fetch bound together', () => {
    expect(ids(topShown(rows(twenty), new Set(), (x) => x.id, 3).shown)).toEqual(['c1', 'c2', 'c3']);
    expect([BOARD_TOP_N, BOARD_FETCH_N]).toEqual([10, 20]);
  });
});

describe('column guards', () => {
  it.each([disabledAccountSql, realGroupMemberSql])('%p needs a table-qualified column', (fn) => {
    expect(fn('lucky_draw_entry.customer_id')).toContain('= lucky_draw_entry.customer_id ');
    for (const bad of ['customer_id', 'x.customer_id; DROP TABLE pull', 'elig_s.customer_id', 'elig_cgc.customer_id', 'ELIG_cg.customer_id', '']) {
      expect(() => fn(bad)).toThrow(/table-qualified/);
    }
  });
});

describe('mayPlay', () => {
  const service = (over: Partial<Record<'disabled' | 'topup', boolean>> = {}) => ({
    isAccountDisabled: jest.fn(async () => over.disabled ?? false),
    hasTopUp: jest.fn(async () => over.topup ?? true),
    walletSummary: jest.fn(async () => ({ isFrozen: false, hasTopup: over.topup ?? true, playthrough: { remaining: 0 } })),
  });
  const ctx = (group: { name: string; metadata: Record<string, unknown> } | null) => {
    const execute = jest.fn(async () => (group ? [group] : []));
    return { ctx: { manager: { execute } } as never, execute };
  };
  const run = (svc: ReturnType<typeof service>, game: 'lucky_draw' | 'coin_flip', c: { ctx: never }) =>
    mayPlay(svc as unknown as PacksModuleService, 'cus_1', game, c.ctx);

  it('lucky draw: a top-up settles it without reading the group, and the disabled check always runs', async () => {
    const svc = service({ disabled: true });
    const c = ctx(null);
    await expect(run(svc, 'lucky_draw', c)).resolves.toBe('unavailable');
    expect(svc.isAccountDisabled).toHaveBeenCalledWith('cus_1', c.ctx);
    const open = service();
    const c2 = ctx(null);
    await expect(run(open, 'lucky_draw', c2)).resolves.toBeNull();
    expect(c2.execute).not.toHaveBeenCalled();
    expect(open.walletSummary).not.toHaveBeenCalled();
  });

  it('lucky draw: without a top-up only a real group lets them in', async () => {
    await expect(run(service({ topup: false }), 'lucky_draw', ctx(null))).resolves.toBe('no_topup');
    const c = ctx({ name: 'Influencers', metadata: {} });
    await expect(run(service({ topup: false }), 'lucky_draw', c)).resolves.toBeNull();
    expect(c.execute).toHaveBeenCalledWith(expect.stringContaining('DISTINCT ON'), ['cus_1']);
  });

  it('coin flip reads the wallet summary (not hasTopUp) and the group policy', async () => {
    const svc = service({ topup: false });
    await expect(run(svc, 'coin_flip', ctx(null))).resolves.toBe('no_topup');
    expect(svc.hasTopUp).not.toHaveBeenCalled();
    expect(svc.walletSummary).toHaveBeenCalledWith('cus_1', undefined, expect.anything());
    await expect(
      run(service({ topup: false }), 'coin_flip', ctx({ name: 'Partner', metadata: { partner_rate_bp: 100, withdrawals_blocked: true } })),
    ).resolves.toBeNull();
  });
});
