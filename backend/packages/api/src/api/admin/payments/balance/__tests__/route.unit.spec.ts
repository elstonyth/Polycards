import { GET } from '../route';
import { setActiveGateway } from '../../../../../modules/packs/gateway';
import { fakeGateway } from '../../../../../modules/packs/fake-gateway';

// The Settlement page's one wallet read, per currency tab. RM reads the
// ACTIVE gateway through the real seam (selecting the fake gateway is the
// whole substitution); a regional currency reads its own rail.
const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL };
  process.env.PAYMENT_GATEWAY = 'fake';
  process.env.GATEWAY_ENABLED = 'true';
  delete process.env.A3PAY_ENABLED;
  setActiveGateway(null);
  fakeGateway.reset();
  fakeGateway.script({
    checkBalance: {
      currentBalance: 300,
      availableBalance: 249,
      t1Balance: 0,
      currencyCode: 'MYR',
      notes: [],
    },
  });
});

afterAll(() => {
  process.env = ORIGINAL;
  setActiveGateway(null);
});

function run(query: Record<string, string> = {}) {
  const packs = {
    siteSettings: jest.fn(async () => ({ payment_gateway: null })),
  };
  const res = {
    body: undefined as unknown,
    setHeader: jest.fn(),
    json(payload: unknown) {
      this.body = payload;
    },
  };
  const req = { scope: { resolve: () => packs }, query };
  return GET(req as never, res as never).then(() => res.body as never);
}

describe('GET /admin/payments/balance', () => {
  it('RM: the active gateway, named, with its wallet', async () => {
    expect(await run()).toEqual({
      currency: 'MYR',
      gateway: 'fake',
      label: 'Fake gateway (tests)',
      enabled: true,
      balance: { currency_code: 'MYR', current: 300, available: 249, t1: 0 },
      error: null,
    });
    expect(fakeGateway.calls.balances).toEqual([{ kind: 'fake' }]);
  });

  it('a wallet the gateway did not report is said beside the balance', async () => {
    fakeGateway.script({
      checkBalance: {
        currentBalance: 300,
        availableBalance: 0,
        t1Balance: 0,
        currencyCode: 'MYR',
        notes: ['no payout wallet for MYR'],
      },
    });
    const body: { balance: unknown; error: string } = await run();
    expect(body.balance).not.toBeNull();
    expect(body.error).toBe('no payout wallet for MYR');
  });

  it('an unreachable gateway is an answer, not a 500', async () => {
    fakeGateway.script({ checkBalance: new Error('403 not allowed') });
    expect(await run()).toMatchObject({
      enabled: true,
      balance: null,
      error: '403 not allowed',
    });
  });

  it('SGD: the A3Pay rail, never the active RM gateway', async () => {
    expect(await run({ currency: 'SGD' })).toMatchObject({
      currency: 'SGD',
      gateway: 'a3pay',
      label: 'A3Pay (SGD)',
      // A3PAY_ENABLED is unset here, so the rail is off — and not called.
      enabled: false,
      balance: null,
    });
    expect(fakeGateway.calls.balances).toEqual([]);
  });

  it('refuses a currency no rail settles in', async () => {
    await expect(run({ currency: 'EUR' })).rejects.toThrow(
      /'currency' must be one of/,
    );
  });
});
