import {
  renderTemplate,
  TOPUP_RECEIPT_TEMPLATE,
} from '../../resend/templates';
import {
  receiptSiteUrl,
  sendTopupReceipt,
  topupReceiptKey,
} from '../topup-receipt';

const DATA = {
  amount_myr: 250,
  reference: 'D2026072912415767',
  payment_method: 'BQR',
  occurred_at: '2026-07-29T12:18:00.000Z',
  site_url: 'https://polycards.gg',
};

describe('topup receipt template', () => {
  it('states the amount, method, reference and MYT date', () => {
    const r = renderTemplate(TOPUP_RECEIPT_TEMPLATE, DATA)!;
    expect(r.subject).toBe('Your RM 250.00 top-up is in — Polycards');
    for (const body of [r.html, r.text]) {
      expect(body).toContain('RM 250.00');
      // The label, not the gateway's code — 'BQR' means nothing to a customer.
      expect(body).toContain('QR / e-wallet');
      expect(body).toContain('D2026072912415767');
      // 12:18 UTC is 20:18 in Malaysia, where every customer and amount is.
      expect(body).toContain('29 Jul 2026, 20:18 (MYT)');
    }
  });

  it('always shows 2dp, so a round amount does not read as rounded', () => {
    const r = renderTemplate(TOPUP_RECEIPT_TEMPLATE, {
      ...DATA,
      amount_myr: 50,
    })!;
    expect(r.text).toContain('RM 50.00');
    expect(r.text).not.toContain('RM 50\n');
  });

  it('groups thousands', () => {
    const r = renderTemplate(TOPUP_RECEIPT_TEMPLATE, {
      ...DATA,
      amount_myr: 10000,
    })!;
    expect(r.subject).toContain('RM 10,000.00');
  });

  it('links the storefront and loads the logo from it', () => {
    const r = renderTemplate(TOPUP_RECEIPT_TEMPLATE, DATA)!;
    expect(r.html).toContain('https://polycards.gg/transactions');
    expect(r.html).toContain(
      'src="https://polycards.gg/branding/polycards-logo.png"',
    );
  });

  // A receipt missing the amount or the reference is worse than none: it says
  // money moved without saying how much or letting support trace it.
  it.each([
    ['amount', { ...DATA, amount_myr: 0 }],
    ['negative amount', { ...DATA, amount_myr: -5 }],
    ['non-numeric amount', { ...DATA, amount_myr: '250' }],
    ['reference', { ...DATA, reference: '' }],
    ['site url', { ...DATA, site_url: '' }],
  ])('fails closed on a bad %s rather than sending a vague receipt', (_l, d) => {
    expect(renderTemplate(TOPUP_RECEIPT_TEMPLATE, d)).toBeUndefined();
  });

  it('escapes a reference so a hostile value cannot inject markup', () => {
    const r = renderTemplate(TOPUP_RECEIPT_TEMPLATE, {
      ...DATA,
      reference: '<script>x</script>',
    })!;
    expect(r.html).not.toContain('<script>x</script>');
    expect(r.html).toContain('&lt;script&gt;');
  });

  it('falls back to the raw code for a method it has no label for', () => {
    const r = renderTemplate(TOPUP_RECEIPT_TEMPLATE, {
      ...DATA,
      payment_method: 'XYZ',
    })!;
    expect(r.text).toContain('XYZ');
  });
});

describe('receiptSiteUrl', () => {
  it('prefers STOREFRONT_URL, then the Mercur name, then the live origin', () => {
    expect(receiptSiteUrl({ STOREFRONT_URL: 'https://a.test/' })).toBe(
      'https://a.test',
    );
    expect(receiptSiteUrl({ MERCUR_STOREFRONT_URL: 'https://b.test' })).toBe(
      'https://b.test',
    );
    // Never a localhost default: a real receipt with a dead link is the trap
    // STOREFRONT_URL already fell into once.
    expect(receiptSiteUrl({})).toBe('https://polycards.gg');
  });
});

describe('sendTopupReceipt', () => {
  const input = {
    customerId: 'cus_1',
    amount: 250,
    reference: 'D1',
    merchantTransactionId: 'PC-1',
    paymentMethodCode: 'BQR',
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

  it('emails the customer, anchored on the SIGNED reference', async () => {
    const h = harness();
    await expect(sendTopupReceipt(h.container, input)).resolves.toBe(true);
    expect(h.createNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'a@b.c',
        channel: 'email',
        template: TOPUP_RECEIPT_TEMPLATE,
        // Not the unsigned gateway id: that could be varied to mint a second
        // receipt for one payment.
        idempotency_key: topupReceiptKey('PC-1'),
      }),
    );
    expect(h.createNotifications.mock.calls[0][0].data).toMatchObject({
      amount_myr: 250,
      reference: 'D1',
      payment_method: 'BQR',
    });
  });

  it('skips silently when the account has no email', async () => {
    const h = harness({ customer: { retrieveCustomer: async () => ({}) } });
    await expect(sendTopupReceipt(h.container, input)).resolves.toBe(false);
    expect(h.createNotifications).not.toHaveBeenCalled();
  });

  // THE rule for this path: the credit is already committed when this runs.
  it('never throws when the send fails — a committed credit outranks an email', async () => {
    const h = harness({
      notification: {
        createNotifications: async () => {
          throw new Error('resend down');
        },
      },
    });
    await expect(sendTopupReceipt(h.container, input)).resolves.toBe(false);
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
    await expect(sendTopupReceipt(h.container, input)).resolves.toBe(false);
  });
});
