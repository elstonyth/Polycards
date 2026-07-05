import { POST } from '../fx/route';
import { GET as history } from '../fx/history/route';

const mkRes = () => {
  const out: { body?: any } = {};
  return { res: { json: (b: any) => (out.body = b) } as any, out };
};

describe('FX override audit', () => {
  it('POST delegates to editFxOverride with adminId + reason', async () => {
    const calls: any[] = [];
    const scope = {
      resolve: () => ({
        editFxOverride: async (input: any) => {
          calls.push(input);
          return { effective: 4.9 };
        },
      }),
    };
    const { res, out } = mkRes();
    await POST(
      {
        scope,
        auth_context: { actor_id: 'admin_1' },
        body: { manual_override: true, manual_rate: 4.9, reason: 'rate drift' },
      } as any,
      res,
    );
    expect(calls[0]).toMatchObject({
      manualOverride: true,
      manualRate: 4.9,
      adminId: 'admin_1',
      reason: 'rate drift',
    });
    expect(out.body.effective).toBe(4.9);
  });

  it('POST rejects a missing reason', async () => {
    const scope = { resolve: () => ({ editFxOverride: async () => ({}) }) };
    const { res } = mkRes();
    await expect(
      POST(
        {
          scope,
          auth_context: { actor_id: 'admin_1' },
          body: { manual_override: false },
        } as any,
        res,
      ),
    ).rejects.toThrow(/reason/i);
  });

  it('history returns mapped audit rows', async () => {
    const scope = {
      resolve: () => ({
        listAdminActionAudits: async () => [
          {
            created_at: new Date('2026-07-06'),
            admin_id: 'admin_1',
            before: { manual_override: false, manual_rate: null },
            after: { manual_override: true, manual_rate: 4.9 },
            reason: 'rate drift',
          },
        ],
      }),
    };
    const { res, out } = mkRes();
    await history({ scope } as any, res);
    expect(out.body.changes).toHaveLength(1);
    expect(out.body.changes[0].admin_id).toBe('admin_1');
  });
});
