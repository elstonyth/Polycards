import { POST } from '../route';
import { PACKS_MODULE } from '../../../../../modules/packs';

// A prize shipped from an address saved without a phone reached ops with no
// number to call (2026-11-04). The route now falls back to the profile phone,
// as the vault path does.

jest.mock('../../../../../modules/packs/pricing', () => ({
  resolveFxRateStrict: jest.fn(async () => 4.5),
}));

const ADDRESS = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  address1: '1 Jalan Utama',
  city: 'Kuala Lumpur',
  postalCode: '50000',
  countryCode: 'my',
};

const recordRewardWithdrawal = jest.fn(async () => ({ status: 'requested' }));
const listCustomers = jest.fn(async () => [
  { id: 'cus_1', phone: '+60107667787' },
]);

const mkReq = (address: Record<string, unknown>) => ({
  auth_context: { actor_id: 'cus_1' },
  body: { pull_id: 'pull_1', address },
  scope: {
    resolve: (key: string) =>
      key === PACKS_MODULE ? { recordRewardWithdrawal } : { listCustomers },
  },
});
const res = { json: jest.fn() };

beforeEach(() => jest.clearAllMocks());

describe('POST /store/rewards/withdraw phone', () => {
  it('uses the profile phone when the address has none', async () => {
    await POST(mkReq(ADDRESS) as never, res as never);
    expect(listCustomers).toHaveBeenCalledWith({ id: 'cus_1' }, { take: 1 });
    expect(recordRewardWithdrawal).toHaveBeenCalledWith(
      'cus_1',
      'pull_1',
      expect.objectContaining({ phone: '+60107667787' }),
      4.5,
    );
  });

  it('keeps the phone typed on the address', async () => {
    await POST(mkReq({ ...ADDRESS, phone: ' 0123456789 ' }) as never, res as never);
    expect(listCustomers).not.toHaveBeenCalled();
    expect(recordRewardWithdrawal).toHaveBeenCalledWith(
      'cus_1',
      'pull_1',
      expect.objectContaining({ phone: '0123456789' }),
      4.5,
    );
  });

  it('ships with no phone when the profile has none either', async () => {
    listCustomers.mockResolvedValueOnce([{ id: 'cus_1', phone: '' }]);
    await POST(mkReq(ADDRESS) as never, res as never);
    expect(recordRewardWithdrawal).toHaveBeenCalledWith(
      'cus_1',
      'pull_1',
      expect.objectContaining({ phone: undefined }),
      4.5,
    );
  });
});
