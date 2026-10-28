jest.mock('../../../../../../modules/packs/gateway', () => {
  const actual = jest.requireActual('../../../../../../modules/packs/gateway');
  return {
    ...actual,
    resolveActiveGateway: jest.fn(async () => 'fake'),
    gatewayConfigFor: jest.fn((kind: string) => ({ kind })),
    getSupportedBanks: jest.fn(async ({ kind }: { kind: string }) =>
      kind === 'a3pay'
        ? [
            { bankCode: 'MBBESGSG', bankName: 'Maybank (SG)' },
            { bankCode: 'PAYNOWSG', bankName: 'PayNow' },
            { bankCode: 'ALLIANCESG', bankName: 'Alliance Bank (SG)' },
            { bankCode: 'UNKNOWNBANK', bankName: 'Unverified bank' },
          ]
        : [{ bankCode: 'MBBEMYKL', bankName: 'Maybank' }],
    ),
  };
});
jest.mock('../../../../../../modules/packs/gateway-withdrawal', () => ({
  withdrawalsEnabled: jest.fn(() => true),
  regionalPayoutGateways: jest.fn(() => ['a3pay']),
}));

import { GET } from '../route';

it('returns bank-specific account lengths from the registry beside payout currency', async () => {
  const res = { json: jest.fn() };
  await GET({ scope: {} } as never, res as never);
  expect(res.json).toHaveBeenCalledWith({
    banks: [
      {
        bankCode: 'MBBEMYKL',
        bankName: 'Maybank',
        currency: 'MYR',
        accountLengths: [12],
      },
      {
        bankCode: 'MBBESGSG',
        bankName: 'Maybank (SG)',
        currency: 'SGD',
        accountLengths: [11],
      },
      {
        bankCode: 'PAYNOWSG',
        bankName: 'PayNow',
        currency: 'SGD',
        accountLengths: [7, 8, 9, 10, 11, 12, 13, 14, 15],
        accountPattern: '^[1-9][0-9]{6,14}$',
        accountHint:
          'Enter the mobile number linked to PayNow, with country code for overseas numbers (digits only).',
      },
    ],
  });
});
