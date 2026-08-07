import {
  renderTemplate,
  WITHDRAWAL_RECEIPT_TEMPLATE,
} from '../../resend/templates';
import {
  sendWithdrawalReceipt,
  withdrawalReceiptKey,
} from '../withdrawal-receipt';

const DATA = {
  amount_myr: 120,
  reference: 'W2026072202370961',
  outcome: 'paid',
  occurred_at: '2026-07-22T02:40:00.000Z',
  site_url: 'https://polycards.gg',
};

describe('withdrawal receipt template', () => {
  it('paid: states the amount, reference and MYT date', () => {
    const r = renderTemplate(WITHDRAWAL_RECEIPT_TEMPLATE, DATA)!;
    expect(r.subject).toBe(
      'Your RM 120.00 withdrawal has been paid — Polycards',
    );
    for (const body of [r.html, r.text]) {
      expect(body).toContain('RM 120.00');
      expect(body).toContain('W2026072202370961');
      // 02:40 UTC is 10:40 in Malaysia, where every customer and amount is.
      expect(body).toContain('22 Jul 2026, 10:40 (MYT)');
    }
  });

  it('refunded: says the money came back, not that it was paid', () => {
    const r = renderTemplate(WITHDRAWAL_RECEIPT_TEMPLATE, {
      ...DATA,
      outcome: 'refunded',
    })!;
    expect(r.subject).toBe(
      'Your RM 120.00 withdrawal was returned to your balance — Polycards',
    );
    expect(r.text).toContain('back in your Polycards balance');
    expect(r.text).not.toContain('reached your bank');
  });

  it('never carries the destination bank account', () => {
    // Email is the least private channel this data could travel through; the
    // reference is what support needs, the account is on the admin row.
    const r = renderTemplate(WITHDRAWAL_RECEIPT_TEMPLATE, DATA)!;
    expect(r.html).not.toMatch(/account/i);
    expect(r.text).not.toMatch(/account/i);
  });

  it('links the storefront and loads the logo from it', () => {
    const r = renderTemplate(WITHDRAWAL_RECEIPT_TEMPLATE, DATA)!;
    expect(r.html).toContain('https://polycards.gg/transactions');
    expect(r.html).toContain(
      'src="https://polycards.gg/branding/polycards-logo.png"',
    );
  });

  // Same fail-closed rule as the top-up receipt: an email about a payout with
  // no amount, no reference, or an unrecognized outcome misinforms.
  it.each([
    ['amount', { ...DATA, amount_myr: 0 }],
    ['negative amount', { ...DATA, amount_myr: -5 }],
    ['non-numeric amount', { ...DATA, amount_myr: '120' }],
    ['reference', { ...DATA, reference: '' }],
    ['outcome', { ...DATA, outcome: 'exploded' }],
    ['site url', { ...DATA, site_url: '' }],
  ])('fails closed on a bad %s rather than sending a vague receipt', (_l, d) => {
    expect(renderTemplate(WITHDRAWAL_RECEIPT_TEMPLATE, d)).toBeUndefined();
  });

  it('escapes a reference so a hostile value cannot inject markup', () => {
    const r = renderTemplate(WITHDRAWAL_RECEIPT_TEMPLATE, {
      ...DATA,
      reference: '<script>x</script>',
    })!;
    expect(r.html).not.toContain('<script>x</script>');
    expect(r.html).toContain('&lt;script&gt;');
  });
});

describe('withdrawalReceiptKey', () => {
  it('scopes the anchor per outcome so the families stay disjoint', () => {
    expect(withdrawalReceiptKey('PC-1', 'paid')).not.toBe(
      withdrawalReceiptKey('PC-1', 'refunded'),
    );
    expect(withdrawalReceiptKey('PC-1', 'paid')).toContain('PC-1');
  });
});

describe('sendWithdrawalReceipt', () => {
  const input = {
    customerId: 'cus_1',
    amount: 120,
    reference: 'W1',
    merchantTransactionId: 'PC-1',
    outcome: 'paid' as const,
  };

  const harness = (over: Record<string, unknown> = {}) => {
    const createNotifications = jest.fn().mockResolvedValue(undefined);
    const retrieveCustomer = jest
      .fn()
      .mockResolvedValue({ id: 'cus_1', email: 'a@b.c' });
    const error = jest.fn();
    const container = {
      resolve: (key: string) => {
        if (key === 'logger') return { error };
        if (String(key).toLowerCase().includes('customer')) {
          return { retrieveCustomer, ...(over.customer as object) };
        }
        return { createNotifications, ...(over.notification as object) };
      },
    };
    return { container, createNotifications, retrieveCustomer, error };
  };

  it('emails the customer, anchored on the SIGNED reference + outcome', async () => {
    const h = harness();
    await expect(sendWithdrawalReceipt(h.container, input)).resolves.toBe(true);
    expect(h.createNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'a@b.c',
        channel: 'email',
        template: WITHDRAWAL_RECEIPT_TEMPLATE,
        // Not the unsigned gateway id: that could be varied to mint a second
        // email for one payout.
        idempotency_key: withdrawalReceiptKey('PC-1', 'paid'),
      }),
    );
    expect(h.createNotifications.mock.calls[0][0].data).toMatchObject({
      amount_myr: 120,
      reference: 'W1',
      outcome: 'paid',
    });
  });

  it('skips silently when the account has no email', async () => {
    const h = harness({ customer: { retrieveCustomer: async () => ({}) } });
    await expect(sendWithdrawalReceipt(h.container, input)).resolves.toBe(
      false,
    );
    expect(h.createNotifications).not.toHaveBeenCalled();
  });

  // THE rule for this path: the settle/refund is already committed.
  it('never throws when the send fails — committed money outranks an email', async () => {
    const h = harness({
      notification: {
        createNotifications: async () => {
          throw new Error('resend down');
        },
      },
    });
    await expect(sendWithdrawalReceipt(h.container, input)).resolves.toBe(
      false,
    );
    expect(h.error).toHaveBeenCalledWith(expect.stringMatching(/PC-1/));
  });

  it('never throws when the customer lookup fails either', async () => {
    const h = harness({
      customer: {
        retrieveCustomer: async () => {
          throw new Error('db gone');
        },
      },
    });
    await expect(sendWithdrawalReceipt(h.container, input)).resolves.toBe(
      false,
    );
  });
});
