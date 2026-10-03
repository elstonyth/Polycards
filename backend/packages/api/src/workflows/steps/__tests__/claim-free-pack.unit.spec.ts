jest.mock('../../../modules/packs/group-policy', () => ({
  ...jest.requireActual('../../../modules/packs/group-policy'),
  resolveGroupPolicyForCustomer: jest.fn(async () => null),
}));

import type { MedusaContainer } from '@medusajs/framework/types';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../modules/packs';
import { FREE_WELCOME_CATEGORY } from '../../../modules/packs/free-pack';
import { resolveGroupPolicyForCustomer } from '../../../modules/packs/group-policy';
import { claimFreePackInvoke } from '../claim-free-pack';

// The free welcome pack unlocks on a verified phone (operator decision
// 2026-09-30): 90 phone-unverified accounts had claimed one, six of them
// created within five minutes. Same predicate as the money/goods gates
// (requirePhoneVerified), and checked BEFORE the one-time claim so a refused
// open leaves it unspent.

const groupPolicy = resolveGroupPolicyForCustomer as jest.Mock;

function harness(opts: { verified: boolean; category?: string }) {
  const packs = {
    listPacks: jest.fn(async () => [
      {
        slug: 'free-welcome',
        category: opts.category ?? FREE_WELCOME_CATEGORY,
      },
    ]),
    isFrozen: jest.fn(async () => false),
    isPhoneVerified: jest.fn(async () => opts.verified),
    claimFreePack: jest.fn(async () => true),
  };
  const container = {
    resolve: (key: string) => {
      if (key === PACKS_MODULE) return packs;
      throw new Error(`unit stub: unexpected container.resolve("${key}")`);
    },
  } as unknown as MedusaContainer;
  return { packs, ctx: { container } };
}

const INPUT = { pack_id: 'free-welcome', customer_id: 'cus_1' };
const ENV_KEYS = [
  'PHONE_VERIFICATION_REQUIRED',
  'PHONE_GATE_REQUIRED',
] as const;
const saved = ENV_KEYS.map((k) => process.env[k]);

beforeEach(() => {
  groupPolicy.mockResolvedValue(null);
  process.env.PHONE_VERIFICATION_REQUIRED = 'true';
  delete process.env.PHONE_GATE_REQUIRED;
});

afterAll(() =>
  ENV_KEYS.forEach((k, i) => {
    if (saved[i] === undefined) delete process.env[k];
    else process.env[k] = saved[i];
  }),
);

describe('claimFreePackInvoke — the phone gate', () => {
  it('refuses an unverified account and leaves its one-time claim unspent', async () => {
    const h = harness({ verified: false });
    const err = await claimFreePackInvoke(INPUT, h.ctx).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(MedusaError);
    expect((err as MedusaError).type).toBe(MedusaError.Types.NOT_ALLOWED);
    expect((err as Error).message).toMatch(/verify your phone/i);
    expect(h.packs.claimFreePack).not.toHaveBeenCalled();
  });

  it('claims for a verified account', async () => {
    const h = harness({ verified: true });
    const res = await claimFreePackInvoke(INPUT, h.ctx);

    expect(res.output).toEqual({ free: true });
    expect(h.packs.claimFreePack).toHaveBeenCalledWith('cus_1');
  });

  it('claims for an unverified member of a verification-exempt partner group', async () => {
    groupPolicy.mockResolvedValue({
      group: { id: 'g1', name: 'Partners' },
      policy: {
        partner_rate_bp: 300,
        withdrawals_blocked: true,
        verification_exempt: true,
      },
    });
    const h = harness({ verified: false });
    const res = await claimFreePackInvoke(INPUT, h.ctx);

    expect(res.output).toEqual({ free: true });
  });

  it('follows the money gate off: the rollback lever reopens the claim too', async () => {
    process.env.PHONE_GATE_REQUIRED = 'false';
    const h = harness({ verified: false });
    const res = await claimFreePackInvoke(INPUT, h.ctx);

    expect(res.output).toEqual({ free: true });
    expect(h.packs.isPhoneVerified).not.toHaveBeenCalled();
  });

  it('never gates a paid pack: this step is a no-op there', async () => {
    const h = harness({ verified: false, category: 'pokemon' });
    const res = await claimFreePackInvoke(INPUT, h.ctx);

    expect(res.output).toEqual({ free: false });
    expect(h.packs.isPhoneVerified).not.toHaveBeenCalled();
  });
});
