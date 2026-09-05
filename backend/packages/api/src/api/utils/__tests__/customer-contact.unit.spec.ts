import { contactFromRecord } from '../customer-contact';

describe('contactFromRecord — what TGPay is told about the payer', () => {
  it('joins the name, keeps the email, strips phone formatting', () => {
    expect(
      contactFromRecord(
        {
          email: 'a@x.test',
          first_name: 'Ada',
          last_name: 'Lovelace',
          phone: '+60 12-345 6789',
        },
        'payment',
      ),
    ).toEqual({
      name: 'Ada Lovelace',
      email: 'a@x.test',
      phoneNumber: '+60123456789',
    });
  });

  it('falls back to the email local part, then a neutral label, for the name', () => {
    expect(
      contactFromRecord({ email: 'ada@x.test', phone: '0123456789' }, 'payment')
        .name,
    ).toBe('ada');
    expect(contactFromRecord({ phone: '0123456789' }, 'payment').name).toBe(
      'Customer',
    );
  });

  it('refuses a PAYMENT for a customer with no phone instead of inventing one', () => {
    expect(() =>
      contactFromRecord(
        { email: 'a@x.test', first_name: 'Ada', phone: null },
        'payment',
      ),
    ).toThrow(/verify your phone/i);
    expect(() => contactFromRecord({ phone: ' - ' }, 'payment')).toThrow(
      /verify your phone/i,
    );
  });

  it('a PAYOUT needs only the email, so a missing phone is not held against it', () => {
    expect(
      contactFromRecord({ email: 'a@x.test', phone: null }, 'payout'),
    ).toEqual({ name: 'a', email: 'a@x.test', phoneNumber: '' });
  });
});
