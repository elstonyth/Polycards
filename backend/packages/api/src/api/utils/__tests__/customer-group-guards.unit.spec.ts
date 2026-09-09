import { MedusaError, Modules } from '@medusajs/framework/utils';
import {
  blockGroupWithdrawals,
  GROUP_POLICY_METADATA_MESSAGE,
  rejectGroupPolicyMetadata,
  stripAdditionalData,
  WITHDRAWALS_BLOCKED_MESSAGE,
} from '../customer-group-guards';

describe('rejectGroupPolicyMetadata', () => {
  const run = (body: unknown) =>
    new Promise<unknown>((resolve) => {
      rejectGroupPolicyMetadata({ body } as never, {} as never, resolve);
    });

  // The native metadata write has no bounds and no audit — every policy key
  // must be turned away, whatever the value.
  it.each([
    ['partner_rate_bp', 10000],
    ['withdrawals_blocked', true],
    ['verification_exempt', false],
  ])('refuses metadata carrying %s', async (key, value) => {
    const err = (await run({ metadata: { odds_set: 2, [key]: value } })) as MedusaError;
    expect(err).toBeInstanceOf(MedusaError);
    expect(err.type).toBe(MedusaError.Types.INVALID_DATA);
    expect(err.message).toBe(GROUP_POLICY_METADATA_MESSAGE);
  });

  it('passes the odds-set write and a rename', async () => {
    expect(await run({ metadata: { odds_set: 2 } })).toBeUndefined();
    expect(await run({ name: 'whales' })).toBeUndefined();
    expect(await run({ name: 'whales', metadata: null })).toBeUndefined();
    expect(await run(undefined)).toBeUndefined();
  });
});

describe('stripAdditionalData', () => {
  const run = (body: unknown) => {
    const req = { body } as never;
    let called = false;
    stripAdditionalData(req, {} as never, () => {
      called = true;
    });
    return { called, body: (req as { body: unknown }).body };
  };

  // The prebuilt Edit Customer Group form always sends this key; core's
  // strict validator rejects it. The strip is what makes a rename possible.
  it('removes additional_data and keeps the rest of the body', () => {
    const r = run({ name: 'whales', additional_data: {} });
    expect(r.called).toBe(true);
    expect(r.body).toEqual({ name: 'whales' });
  });

  it('passes a body without the key untouched', () => {
    const r = run({ name: 'whales', metadata: { odds_set: 2 } });
    expect(r.called).toBe(true);
    expect(r.body).toEqual({ name: 'whales', metadata: { odds_set: 2 } });
  });

  it('tolerates a missing body', () => {
    expect(run(undefined).called).toBe(true);
    expect(run(null).called).toBe(true);
  });
});

describe('blockGroupWithdrawals', () => {
  // A customer module stub whose group list is what the resolver reads
  // (oldest-first). `throws` stands in for a DB failure on that read.
  const makeReq = (
    actorId: string | undefined,
    groups: { name: string; metadata?: Record<string, unknown> }[],
    throws = false,
  ) =>
    ({
      auth_context: { actor_id: actorId },
      scope: {
        resolve: (key: string) => {
          if (key === Modules.CUSTOMER)
            return {
              listCustomerGroups: async () => {
                if (throws) throw new Error('db down');
                return groups.map((g, i) => ({ id: `cg_${i}`, ...g }));
              },
            };
          return undefined;
        },
      },
    }) as never;

  const run = (req: never) =>
    new Promise<unknown>((resolve) => {
      blockGroupWithdrawals(req, {} as never, resolve).catch(resolve);
    });

  it('passes a customer in no group', async () => {
    expect(await run(makeReq('cus_1', []))).toBeUndefined();
  });

  it('passes a member of a group that does not block withdrawals', async () => {
    expect(
      await run(
        makeReq('cus_1', [{ name: 'pro', metadata: { partner_rate_bp: 400 } }]),
      ),
    ).toBeUndefined();
  });

  it('refuses a member of a blocking group with NOT_ALLOWED and the exact copy', async () => {
    const err = (await run(
      makeReq('cus_1', [
        {
          name: 'partners',
          metadata: { partner_rate_bp: 400, withdrawals_blocked: true },
        },
      ]),
    )) as MedusaError;
    expect(err).toBeInstanceOf(MedusaError);
    expect(err.type).toBe(MedusaError.Types.NOT_ALLOWED);
    expect(err.message).toBe(WITHDRAWALS_BLOCKED_MESSAGE);
  });

  // DEFAULT is never a policy carrier — a stray flag on that row must not lock
  // every new sign-up out of withdrawing.
  it('ignores a block stored on the DEFAULT group', async () => {
    expect(
      await run(
        makeReq('cus_1', [
          {
            name: 'DEFAULT',
            metadata: { is_default: true, withdrawals_blocked: true },
          },
        ]),
      ),
    ).toBeUndefined();
  });

  it('refuses a register-token bearer (empty actor_id)', async () => {
    const err = (await run(makeReq('', []))) as MedusaError;
    expect(err.type).toBe(MedusaError.Types.UNAUTHORIZED);
  });

  it('fails CLOSED when the group read throws', async () => {
    const err = (await run(makeReq('cus_1', [], true))) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('db down');
  });
});
