import { GET } from '../config/route';
import { setActiveGateway } from '../../../../modules/packs/gateway';
import {
  DEFAULT_WITHDRAWAL_CONTROLS,
  type WithdrawalControls,
} from '../../../../modules/packs/withdrawal-controls';

const ORIGINAL = { ...process.env };

beforeEach(() => {
  delete process.env.PAYMENT_GATEWAY;
  process.env.GATEWAY_ENABLED = 'true';
  process.env.GATEWAY_WITHDRAWALS_ENABLED = 'true';
  process.env.TGPAY_SECRET_KEY = 'sk-test';
  setActiveGateway(null);
});

afterAll(() => {
  process.env = ORIGINAL;
  setActiveGateway(null);
});

function harness(
  setting: string | null,
  controls: WithdrawalControls = DEFAULT_WITHDRAWAL_CONTROLS,
) {
  const packs = {
    siteSettings: jest.fn(async () => ({ payment_gateway: setting })),
    withdrawalControls: jest.fn(async () => controls),
  };
  const req = { scope: { resolve: () => packs } };
  const res = {
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    json(payload: unknown) {
      this.body = payload;
    },
  };
  return { req, res };
}

type Body = {
  gateway: string;
  deposits_enabled: boolean;
  withdrawals_enabled: boolean;
  withdrawals_unavailable: boolean;
  withdrawals_paused_until: string | null;
  deposit: { min_rm: number; max_rm: number };
  withdrawal: { min_rm: number; max_rm: number };
};

describe('GET /store/payments/config — the active gateway money bands', () => {
  it('answers with the ACTIVE gateway band, not the env default', async () => {
    const h = harness('tgpay');
    await GET(h.req as never, h.res as never);
    const body = h.res.body as Body;
    expect(body.gateway).toBe('tgpay');
    expect(body.deposit).toEqual({ min_rm: 50, max_rm: 10000 });
    expect(body.withdrawal).toEqual({ min_rm: 50, max_rm: 30000 });
    expect(body.deposits_enabled).toBe(true);
    expect(body.withdrawals_enabled).toBe(true);
    expect(h.res.headers['Cache-Control']).toBe('no-store');
  });

  it('falls back to the default gateway band when no setting is stored', async () => {
    const h = harness(null);
    await GET(h.req as never, h.res as never);
    const body = h.res.body as Body;
    expect(body.gateway).toBe('tgpay');
    expect(body.deposit).toEqual({ min_rm: 50, max_rm: 10000 });
    expect(body.withdrawal).toEqual({ min_rm: 50, max_rm: 30000 });
  });

  it('reports withdrawals closed when the withdrawal switch is off', async () => {
    process.env.GATEWAY_WITHDRAWALS_ENABLED = 'false';
    const h = harness(null);
    await GET(h.req as never, h.res as never);
    expect((h.res.body as Body).withdrawals_enabled).toBe(false);
  });

  it('reports withdrawals closed with the resume instant during a timed pause', async () => {
    process.env.GATEWAY_WITHDRAWALS_PAUSED_UNTIL = '2999-01-01T06:00:00+08:00';
    try {
      const h = harness(null);
      await GET(h.req as never, h.res as never);
      const body = h.res.body as Body;
      expect(body.withdrawals_enabled).toBe(false);
      expect(body.withdrawals_paused_until).toBe('2998-12-31T22:00:00.000Z');
    } finally {
      delete process.env.GATEWAY_WITHDRAWALS_PAUSED_UNTIL;
    }
  });
  it('is not unavailable while everything is open', async () => {
    const h = harness(null);
    await GET(h.req as never, h.res as never);
    expect((h.res.body as Body).withdrawals_unavailable).toBe(false);
  });

  it('reports withdrawals unavailable, with no end, while the admin switch is off', async () => {
    const h = harness(null, {
      ...DEFAULT_WITHDRAWAL_CONTROLS,
      withdrawals: {
        ...DEFAULT_WITHDRAWAL_CONTROLS.withdrawals,
        open: false,
      },
    });
    await GET(h.req as never, h.res as never);
    const body = h.res.body as Body;
    expect(body.withdrawals_enabled).toBe(false);
    expect(body.withdrawals_unavailable).toBe(true);
    expect(body.withdrawals_paused_until).toBeNull();
  });

  it('names the reopen instant of a switch-off that has one', async () => {
    const h = harness(null, {
      ...DEFAULT_WITHDRAWAL_CONTROLS,
      withdrawals: {
        ...DEFAULT_WITHDRAWAL_CONTROLS.withdrawals,
        open: false,
        off_until: '2999-01-01T00:00:00.000Z',
      },
    });
    await GET(h.req as never, h.res as never);
    const body = h.res.body as Body;
    expect(body.withdrawals_unavailable).toBe(true);
    expect(body.withdrawals_paused_until).toBe('2999-01-01T00:00:00.000Z');
  });

  it('names the reopen instant inside the admin daily window', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-10-17T03:00:00+08:00') });
    try {
      const h = harness(null, {
        ...DEFAULT_WITHDRAWAL_CONTROLS,
        withdrawals: {
          open: true,
          off_until: null,
          schedule: { on: true, close_at: '00:00', reopen_at: '06:00' },
        },
      });
      await GET(h.req as never, h.res as never);
      const body = h.res.body as Body;
      expect(body.withdrawals_unavailable).toBe(true);
      expect(body.withdrawals_paused_until).toBe('2026-10-16T22:00:00.000Z');
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports the env timed pause as unavailable too', async () => {
    process.env.GATEWAY_WITHDRAWALS_PAUSED_UNTIL = '2999-01-01T06:00:00+08:00';
    try {
      const h = harness(null);
      await GET(h.req as never, h.res as never);
      expect((h.res.body as Body).withdrawals_unavailable).toBe(true);
    } finally {
      delete process.env.GATEWAY_WITHDRAWALS_PAUSED_UNTIL;
    }
  });
});
