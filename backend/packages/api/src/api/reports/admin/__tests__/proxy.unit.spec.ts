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
    ['/admin/invites', /staff invites/],
    ['/admin/invites/inv_1', /staff invites/],
    ['/admin/api-keys', /API keys/],
    ['/admin/workflows-executions', /workflow/],
    ['/admin/notifications', /notification/],
    ['/admin/uploads', /uploads/],
    ['/admin/pricecharting/search', /PriceCharting/],
    ['/admin/inventory/export.xlsx', /file exports/],
    ['/admin/players/export', /file exports/],
    // Medusa matches routes case-insensitively: /admin/USERS runs /admin/users.
    ['/admin/INVITES', /staff invites/],
    ['/admin/Api-Keys', /API keys/],
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
    // Open since 2026-10-06: the staff list and full bank numbers.
    '/admin/users',
    '/admin/users/user_1',
    '/admin/payments/withdrawals/wd_1/account',
    '/admin/customers/cus_1/payout-details',
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

  it('says how to narrow in the words it is given', () => {
    const out = capBody({ s: 'x'.repeat(500) }, 100, 'Add LIMIT.') as {
      note: string;
    };
    expect(out.note).toMatch(/too long to show whole\. Add LIMIT\.$/);
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

  // Spec 2026-10-06: the Players list, account_state and the set_real_name
  // audit before/after all carry the real name; none of it reaches Discord.
  it('hides real names wherever they ride', () => {
    expect(
      redact({
        players: [{ id: 'cus_1', real_name: 'Tan Ah Kow' }],
        account_state: { real_name: 'Tan Ah Kow', real_name_set_at: 'x' },
        actions: [{ before: { real_name: 'A' }, after: { real_name: 'B' } }],
      }),
    ).toEqual({
      players: [{ id: 'cus_1', real_name: '[hidden]' }],
      account_state: { real_name: '[hidden]', real_name_set_at: '[hidden]' },
      actions: [
        { before: { real_name: '[hidden]' }, after: { real_name: '[hidden]' } },
      ],
    });
  });

  it('shows bank account numbers whole (open since 2026-10-06)', () => {
    const banks = {
      metadata: {
        bank_accounts: [
          { bankName: 'Maybank', accountNumber: '1234 5678 9012' },
        ],
      },
      account_number: '1234 5678 9012',
      bank_account_number: '5550001234',
    };
    expect(redact(banks)).toEqual(banks);
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
