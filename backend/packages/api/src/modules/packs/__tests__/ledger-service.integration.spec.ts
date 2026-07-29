import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import LedgerEntry from '../models/ledger-entry';
import LedgerSequence from '../models/ledger-sequence';

jest.setTimeout(300 * 1000);

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [LedgerEntry, LedgerSequence],
  testSuite: ({ service }) => {
    const occurredAt = new Date('2026-08-15T12:00:00Z'); // MYT Q3

    it('allocates a scoped, incrementing display_id and both deltas round-trip', async () => {
      const a = await service.recordLedgerEntry({
        type: 'AD', customerId: 'cus_1', refId: 'ctxn_1',
        walletDelta: 12.34, vaultDelta: null,
        payload: { type: 'AD', admin_id: 'user_1', reason: 'test', detail: null, card_handle: null },
        occurredAt,
      });
      expect(a.display_id).toBe('AD26Q3A0001');
      const b = await service.recordLedgerEntry({
        type: 'AD', customerId: 'cus_2', refId: 'ctxn_2',
        walletDelta: -5, vaultDelta: 7.5,
        payload: { type: 'AD', admin_id: 'user_1', reason: 'test 2', detail: null, card_handle: null },
        occurredAt,
      });
      expect(b.display_id).toBe('AD26Q3A0002');
      const [row] = await service.listLedgerEntries({ id: b.id });
      // bigNumber fields come back as strings/objects from the ORM — Number()
      // normalizes exactly like every other money read site in this file.
      expect(Number(row.wallet_delta)).toBe(-5);
      expect(Number(row.vault_delta)).toBe(7.5);
    });

    it('is idempotent on (type, ref_id) — a replay returns the ORIGINAL row, not a new one', async () => {
      const first = await service.recordLedgerEntry({
        type: 'SE', customerId: 'cus_3', refId: 'ctxn_dup',
        walletDelta: 40, vaultDelta: -40,
        payload: { type: 'SE', card_handle: 'card-x', sp_ref_id: null, price: 40, rate: 0.9 },
        occurredAt,
      });
      const replay = await service.recordLedgerEntry({
        type: 'SE', customerId: 'cus_3', refId: 'ctxn_dup',
        walletDelta: 999, vaultDelta: -999, // different numbers — must be IGNORED
        payload: { type: 'SE', card_handle: 'card-x', sp_ref_id: null, price: 999, rate: 1 },
        occurredAt,
      });
      expect(replay.id).toBe(first.id);
      expect(replay.replayed).toBe(true);
      const rows = await service.listLedgerEntries({ type: 'SE', ref_id: 'ctxn_dup' });
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].wallet_delta)).toBe(40); // the original, not the replay
    });

    it('a different type with the SAME ref_id is a different row (idempotency is per-type)', async () => {
      const od = await service.recordLedgerEntry({
        type: 'OD', customerId: 'cus_4', refId: 'shared-ref',
        walletDelta: 0, vaultDelta: -10,
        payload: { type: 'OD', handles: [{ card_handle: 'c', qty: 1 }], status: 'requested' },
        occurredAt,
      });
      const sp = await service.recordLedgerEntry({
        type: 'SP', customerId: 'cus_4', refId: 'shared-ref',
        walletDelta: -10, vaultDelta: 10,
        payload: { type: 'SP', channel: 'single', pack_id: 'p', prize_skus: ['c'] },
        occurredAt,
      });
      expect(od.id).not.toBe(sp.id);
    });

    it('concurrency: N parallel writers on a FRESH scope never collide and never lose an increment', async () => {
      const freshScopeInstant = new Date('2031-05-01T04:00:00Z'); // a scope no other test touches
      const N = 12;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          service.recordLedgerEntry({
            type: 'WP', customerId: `cus_wp_${i}`, refId: `wp_${i}`,
            walletDelta: 1, vaultDelta: null,
            payload: { type: 'WP', period: '2031-W18', stage: 1, rank: i, sku: null, value: 1 },
            occurredAt: freshScopeInstant,
          }),
        ),
      );
      const ids = new Set(results.map((r) => r.display_id));
      expect(ids.size).toBe(N); // no duplicates
      const [seq] = await service.listLedgerSequences({ scope: 'WP-31-Q2' });
      expect(seq.last_serial).toBe(`a${String(N).padStart(4, '0')}`); // no lost updates
    });
  },
});
