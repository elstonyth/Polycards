import { monitoredCustomerIds, monitoredEmails } from '../automation-monitor';

describe('read-only monitoring selection', () => {
  it('normalizes up to 80 unique email addresses', () => {
    const emails = Array.from(
      { length: 80 },
      (_, i) => `  Account${i}@example.test  `,
    );
    expect(monitoredEmails({ emails })).toEqual(
      emails.map((email) => email.trim().toLowerCase()),
    );
  });

  it.each([
    null,
    {},
    { emails: [] },
    { emails: ['invalid'] },
    { emails: [3] },
    { emails: ['a@example.test', 'A@example.test'] },
    { emails: Array.from({ length: 81 }, (_, i) => `${i}@example.test`) },
    { emails: ['a@example.test'], password: 'must-not-be-accepted' },
  ])('rejects invalid selections and credential fields: %j', (body) => {
    expect(() => monitoredEmails(body)).toThrow();
  });

  it('distinguishes empty configuration from corrupted saved selection', () => {
    expect(monitoredCustomerIds(undefined)).toEqual([]);
    expect(monitoredCustomerIds({ customer_ids: ['cus_a'] })).toEqual([
      'cus_a',
    ]);
    for (const accounts of [
      {},
      { customer_ids: ['cus_a', 'cus_a'] },
      { customer_ids: [4] },
    ]) {
      expect(() => monitoredCustomerIds(accounts)).toThrow();
    }
  });
});
