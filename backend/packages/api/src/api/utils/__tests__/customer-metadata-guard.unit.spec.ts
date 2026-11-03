import { rejectAdminBankAccountsMetadata } from '../customer-metadata-guard';

// The generic admin customer route accepts metadata, so the keys that move money
// are refused there. Their own routes are the only writers, and those audit.
const run = (body: unknown) => {
  const next = jest.fn();
  rejectAdminBankAccountsMetadata({ body } as never, {} as never, next);
  return next;
};

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
