import { adminPathError, blockedReason, capBody, redact } from '../proxy';

describe('adminPathError', () => {
  it.each([
    '/admin/customers',
    '/admin/challenge/schedule',
    '/admin/packs/silver-pack/odds',
    '/admin/customers/cus_01ABC/transactions',
  ])('accepts %s', (path) => {
    expect(adminPathError(path)).toBeNull();
  });

  it.each([
    [undefined, /path is required/],
    ['', /path is required/],
    ['/store/customers', /must start with \/admin\//],
    ['admin/customers', /must start with \/admin\//],
    ['/admin/../store/customers', /not a plain admin path/],
    ['/admin//customers', /not a plain admin path/],
    ['/admin/customers?limit=1', /not a plain admin path/],
    ['/admin/customers#x', /not a plain admin path/],
    ['/admin/cust omers', /not a plain admin path/],
    [`/admin/${'x'.repeat(300)}`, /too long/],
    [['/admin/a', '/admin/b'], /path is required/],
  ])('refuses %p', (path, why) => {
    expect(adminPathError(path)).toMatch(why);
  });
});

describe('blockedReason', () => {
  it.each([
    ['/admin/users', /staff logins/],
    ['/admin/users/me', /staff logins/],
    ['/admin/invites', /staff logins/],
    ['/admin/api-keys', /API keys/],
    ['/admin/workflows-executions', /workflow/],
    ['/admin/notifications', /notification/],
    ['/admin/uploads', /uploads/],
    ['/admin/payments/withdrawals/wd_1/account', /full bank number/],
    ['/admin/customers/cus_1/payout-details', /full bank number/],
    ['/admin/pricecharting/search', /PriceCharting/],
    ['/admin/inventory/export.xlsx', /file exports/],
    ['/admin/players/export', /file exports/],
    // Medusa matches routes case-insensitively: /admin/USERS runs /admin/users.
    ['/admin/USERS', /staff logins/],
    ['/admin/Api-Keys', /API keys/],
    ['/admin/payments/withdrawals/wd_1/ACCOUNT', /full bank number/],
    ['/admin/customers/cus_1/Payout-Details', /full bank number/],
    ['/admin/inventory/EXPORT.XLSX', /file exports/],
  ])('blocks %s', (path, why) => {
    expect(blockedReason(path)).toMatch(why);
  });

  it.each([
    '/admin/customers',
    '/admin/payments/withdrawals',
    '/admin/challenge/schedule',
    '/admin/userscore',
    '/admin/players',
  ])('allows %s', (path) => {
    expect(blockedReason(path)).toBeNull();
  });
});

describe('capBody', () => {
  it('passes a small answer through whole', () => {
    expect(capBody({ a: 1 }, 100)).toEqual({
      truncated: false,
      data: { a: 1 },
    });
  });

  it('cuts a big answer and says how to narrow it', () => {
    const big = {
      rows: Array.from({ length: 500 }, (_, i) => ({
        i,
        name: 'x'.repeat(50),
      })),
    };
    const out = capBody(big, 2000) as {
      truncated: boolean;
      data_preview: string;
      note: string;
    };
    expect(out.truncated).toBe(true);
    expect(out.data_preview.length).toBeLessThanOrEqual(2000);
    expect(out.note).toMatch(/limit/);
  });
});

describe('redact', () => {
  it('hides passwords, credentials, secrets, tokens and API keys at any depth', () => {
    expect(
      redact({
        customers: [
          {
            id: 'cus_1',
            metadata: {
              handle: 'ace',
              partner_credential: { password: 'pw', issued_at: '2026-09-09' },
            },
          },
        ],
        token: 't',
        apiKey: 'k',
        client_secret: 's',
        password_hash: 'h',
      }),
    ).toEqual({
      customers: [
        {
          id: 'cus_1',
          metadata: { handle: 'ace', partner_credential: '[hidden]' },
        },
      ],
      token: '[hidden]',
      apiKey: '[hidden]',
      client_secret: '[hidden]',
      password_hash: '[hidden]',
    });
  });

  it('keeps only the last 4 digits of a bank account number', () => {
    expect(
      redact({
        metadata: {
          bank_accounts: [
            { bankName: 'Maybank', accountNumber: '1234 5678 9012' },
          ],
        },
        account_number: '****9012',
        bank_account_number: '5550001234',
        none: { account_number: null },
      }),
    ).toEqual({
      metadata: {
        bank_accounts: [{ bankName: 'Maybank', accountNumber: '••••9012' }],
      },
      account_number: '••••9012',
      bank_account_number: '••••1234',
      none: { account_number: null },
    });
  });

  it('leaves everything else as it is', () => {
    const plain = {
      id: 'cus_1',
      email: 'ace@example.com',
      phone: '+60123456789',
      first_name: 'Ace',
      total: 3,
      has_account: true,
      deleted_at: null,
      groups: [{ id: 'g1', name: 'Default' }],
    };
    expect(redact(plain)).toEqual(plain);
    expect(redact([1, 'a', null])).toEqual([1, 'a', null]);
  });
});
