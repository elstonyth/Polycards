import {
  hideStoreCustomerMetadata,
  rejectAdminBankAccountsMetadata,
} from '../customer-metadata-guard';

// The generic admin customer route accepts metadata, so the keys that move money
// are refused there. Their own routes are the only writers, and those audit.
const run = (body: unknown) => {
  const next = jest.fn();
  rejectAdminBankAccountsMetadata({ body } as never, {} as never, next);
  return next;
};

describe('hideStoreCustomerMetadata', () => {
  it("strips support's name-clash notes from the customer's own record, keeps the rest", () => {
    const sent: unknown[] = [];
    const res = { json: (b: unknown) => sent.push(b) } as never;
    hideStoreCustomerMetadata({} as never, res, jest.fn());
    (res as { json: (b: unknown) => void }).json({
      customer: {
        metadata: {
          handle: 'x',
          holder_name_cleared: { tanahkow: { name: 'n', at: 't', with: ['cus_2'] } },
        },
      },
    });
    expect(sent[0]).toEqual({ customer: { metadata: { handle: 'x' } } });
  });
});

describe('rejectAdminBankAccountsMetadata', () => {
  it.each(['bank_accounts', 'bank_share_verified', 'holder_name_cleared'])('refuses %s', (key) => {
    const next = run({ metadata: { handle: 'x', [key]: 'anything' } });
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]?.message).toContain(key);
  });

  it('refuses clearing the whole blob, which would wipe a tied bank account', () => {
    const next = run({ metadata: null });
    expect(next.mock.calls[0][0]?.message).toMatch(/cannot be cleared/);
  });

  it('lets any other metadata key through', () => {
    const next = run({ metadata: { handle: 'x' } });
    expect(next).toHaveBeenCalledWith();
  });

  it('lets a body with no metadata through', () => {
    expect(run({ first_name: 'x' })).toHaveBeenCalledWith();
    expect(run(undefined)).toHaveBeenCalledWith();
  });
});
