import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { Migration20261030100000 as TicketSpinMigration } from '../../src/modules/packs/migrations/Migration20261030100000';
import { Migration20261030110000 as OneWinnerMigration } from '../../src/modules/packs/migrations/Migration20261030110000';

jest.setTimeout(240 * 1000);

// The hand-written DDL behind the ticket spin and the one-winner draw, on the
// database the real migrations built. The module integration tier builds its
// schema from the MODELS, so none of these CHECKs or partial indexes exist there:
// this suite is the only proof they do what the design relies on.

type Knex = {
  raw: (
    sql: string,
    bindings?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
};
type MigrationProto = {
  addSql: (s: string) => void;
  up: () => Promise<void>;
  down: () => Promise<void>;
};

async function replay(
  knex: Knex,
  prototype: object,
  dir: 'up' | 'down',
): Promise<void> {
  const sql: string[] = [];
  const m = Object.create(prototype) as MigrationProto;
  m.addSql = (s) => sql.push(s);
  await m[dir]();
  for (const statement of sql) await knex.raw(statement);
}

/** The constraint or index that refused the statement, or 'accepted'. */
const refusedBy = (
  knex: Knex,
  sql: string,
  bindings: unknown[],
): Promise<string> =>
  knex.raw(sql, bindings).then(
    () => 'accepted',
    (e: { constraint?: string; message: string }) => e.constraint ?? e.message,
  );

const INSERT_PRIZE =
  'INSERT INTO ticket_prize (id, pack_id, tickets, rarity, weight) VALUES (?, ?, ?, ?, ?)';
const INSERT_SPIN =
  'INSERT INTO ticket_spin (id, customer_id, pack_id, tickets, source, open_id, rolled_at) VALUES (?, ?, ?, ?, ?, ?, now())';
const INSERT_ENTRY =
  'INSERT INTO lucky_draw_entry (id, prize_id, event_id, customer_id, tickets) VALUES (?, ?, ?, ?, ?)';
// What 2026-10-24 code writes: the shape in lucky-draw.integration.spec.ts.
const INSERT_OLD_ENTRY =
  'INSERT INTO lucky_draw_entry (id, prize_id, customer_id, tickets, created_at, updated_at) VALUES (?, ?, ?, ?, now(), now())';
const INSERT_TICKET =
  'INSERT INTO lucky_draw_ticket (id, customer_id, delta, reason, ref) VALUES (?, ?, ?, ?, ?)';
const INSERT_EVENT_RESULT =
  "INSERT INTO lucky_draw_event_result (id, event_id, seed, entries, excluded, drawn_at) VALUES (?, ?, 's', '[]', '[]', now())";

const packInput = (slug: string) => ({
  slug,
  title: slug,
  category: 'poly',
  price: 10,
  image: '/x.webp',
});
const eventInput = () => ({
  name: 'Nov',
  starts_at: new Date(),
  ends_at: new Date(Date.now() + 86400e3),
  created_by: 'user_t',
});
const eventResultInput = (eventId: string) => ({
  event_id: eventId,
  seed: 'seed',
  // model.json() types as a record; the draw writes arrays with the same cast.
  entries: [] as unknown as Record<string, unknown>,
  excluded: [] as unknown as Record<string, unknown>,
  drawn_at: new Date(),
});

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    const db = () =>
      getContainer().resolve(
        ContainerRegistrationKeys.PG_CONNECTION,
      ) as unknown as Knex;
    const service = () =>
      getContainer().resolve<PacksModuleService>(PACKS_MODULE);

    const isNullable = async (table: string, column: string) => {
      const { rows } = await db().raw(
        'SELECT is_nullable FROM information_schema.columns WHERE table_name = ? AND column_name = ?',
        [table, column],
      );
      return rows[0]?.is_nullable;
    };

    describe('ticket spin and one-winner schema', () => {
      it('both migrations built their tables, indexes and CHECKs', async () => {
        const { rows: indexes } = await db().raw(
          'SELECT indexname, indexdef FROM pg_indexes WHERE indexname = ANY(?)',
          [
            [
              'UQ_ticket_prize_pack_tickets',
              'IDX_ticket_spin_customer',
              'IDX_ticket_spin_open',
              'IDX_lucky_draw_entry_prize',
              'IDX_lucky_draw_entry_event',
              'UQ_lucky_draw_event_result_event',
            ],
          ],
        );
        expect(indexes).toHaveLength(6);
        for (const row of indexes) {
          expect(String(row.indexdef)).toContain('WHERE (deleted_at IS NULL)');
        }

        const { rows: checks } = await db().raw(
          'SELECT conname FROM pg_constraint WHERE conname = ANY(?)',
          [
            [
              'pack_prize_type_check',
              'ticket_prize_tickets_check',
              'ticket_prize_rarity_check',
              'ticket_spin_source_check',
              'lucky_draw_ticket_reason_check',
              'lucky_draw_event_draw_mode_check',
              'lucky_draw_entry_one_target_check',
            ],
          ],
        );
        expect(checks).toHaveLength(7);

        expect(await isNullable('lucky_draw_entry', 'prize_id')).toBe('YES');
        expect(await isNullable('lucky_draw_entry', 'event_id')).toBe('YES');
      });

      it('a pack defaults to cards and only takes the two prize types', async () => {
        const [cards, tickets] = await service().createPacks([
          packInput('schema-cards'),
          { ...packInput('schema-tickets'), prize_type: 'tickets' as const },
        ]);
        expect(cards.prize_type).toBe('cards');
        expect(tickets.prize_type).toBe('tickets');
        expect(
          await refusedBy(
            db(),
            'UPDATE pack SET prize_type = ? WHERE slug = ?',
            ['coins', 'schema-cards'],
          ),
        ).toBe('pack_prize_type_check');
      });

      it('ticket_prize holds one live row per amount and refuses a bad amount or rarity', async () => {
        const [prize] = await service().createTicketPrizes([
          { pack_id: 'lucky', tickets: 100, rarity: 'Rare', weight: 250000 },
        ]);
        expect(prize.id).toMatch(/^tkpz_/);
        expect(prize.locked).toBe(false);
        expect(prize.weight_2).toBeNull();
        expect(prize.weight_3).toBeNull();

        expect(
          await refusedBy(db(), INSERT_PRIZE, [
            'tkpz_dup',
            'lucky',
            100,
            'Common',
            1,
          ]),
        ).toBe('UQ_ticket_prize_pack_tickets');
        // The same amount in another pack is fine.
        expect(
          await refusedBy(db(), INSERT_PRIZE, [
            'tkpz_other',
            'other',
            100,
            'Common',
            1,
          ]),
        ).toBe('accepted');
        // A soft-deleted row frees its amount (the index is live rows only).
        await service().softDeleteTicketPrizes([prize.id]);
        expect(
          await refusedBy(db(), INSERT_PRIZE, [
            'tkpz_again',
            'lucky',
            100,
            'Common',
            1,
          ]),
        ).toBe('accepted');

        for (const tickets of [0, -5]) {
          expect(
            await refusedBy(db(), INSERT_PRIZE, [
              `tkpz_${tickets}`,
              'lucky',
              tickets,
              'Common',
              1,
            ]),
          ).toBe('ticket_prize_tickets_check');
        }
        expect(
          await refusedBy(db(), INSERT_PRIZE, [
            'tkpz_bad',
            'lucky',
            5,
            'Shiny',
            1,
          ]),
        ).toBe('ticket_prize_rarity_check');
        expect(
          await refusedBy(db(), INSERT_PRIZE, [
            'tkpz_none',
            'lucky',
            5,
            null,
            1,
          ]),
        ).toMatch(/null value in column "rarity"/);
      });

      it('ticket_spin records a spin and takes only the pull source values', async () => {
        const [spin] = await service().createTicketSpins([
          {
            customer_id: 'cus_a',
            pack_id: 'lucky',
            tickets: 100,
            source: 'pack',
            open_id: 'open_1',
            rolled_at: new Date(),
          },
        ]);
        expect(spin.id).toMatch(/^tksp_/);
        expect(spin.bonus_bp).toBe(0);
        expect(
          await refusedBy(db(), INSERT_SPIN, [
            'tksp_bad',
            'cus_a',
            'lucky',
            5,
            'lucky_pack',
            'open_1',
          ]),
        ).toBe('ticket_spin_source_check');
      });

      it('the ticket ledger accepts pack_spin, once per spin', async () => {
        const [row] = await service().createLuckyDrawTickets([
          {
            customer_id: 'cus_a',
            delta: 100,
            reason: 'pack_spin',
            ref: 'tksp_1',
          },
        ]);
        expect(row.reason).toBe('pack_spin');
        expect(
          await refusedBy(db(), INSERT_TICKET, [
            'ldtk_dup',
            'cus_a',
            100,
            'pack_spin',
            'tksp_1',
          ]),
        ).toBe('UQ_lucky_draw_ticket_reason_ref');
        expect(
          await refusedBy(db(), INSERT_TICKET, [
            'ldtk_bad',
            'cus_a',
            100,
            'bought',
            'tksp_2',
          ]),
        ).toBe('lucky_draw_ticket_reason_check');
      });

      it('an entry has exactly one of prize_id and event_id, and old-shape entries still insert', async () => {
        expect(
          await refusedBy(db(), INSERT_ENTRY, [
            'lden_both',
            'ldpz_1',
            'ldev_1',
            'cus_a',
            5,
          ]),
        ).toBe('lucky_draw_entry_one_target_check');
        expect(
          await refusedBy(db(), INSERT_ENTRY, [
            'lden_neither',
            null,
            null,
            'cus_a',
            5,
          ]),
        ).toBe('lucky_draw_entry_one_target_check');

        expect(
          await refusedBy(db(), INSERT_OLD_ENTRY, [
            'lden_old',
            'ldpz_1',
            'cus_a',
            5,
          ]),
        ).toBe('accepted');
        const [viaPrize, viaEvent] = await service().createLuckyDrawEntries([
          { prize_id: 'ldpz_1', customer_id: 'cus_b', tickets: 7 },
          { event_id: 'ldev_1', customer_id: 'cus_b', tickets: 9 },
        ]);
        expect(viaPrize.event_id).toBeNull();
        expect(viaEvent.prize_id).toBeNull();

        // Each read sees its own kind: an event entry is in no prize's draw.
        const onPrize = await service().listLuckyDrawEntries({
          prize_id: 'ldpz_1',
        });
        expect(onPrize.map((e) => e.tickets).sort()).toEqual([5, 7]);
        const onEvent = await service().listLuckyDrawEntries({
          event_id: 'ldev_1',
        });
        expect(onEvent.map((e) => e.tickets)).toEqual([9]);
      });

      it('an event defaults to per_prize and takes one result only', async () => {
        const [oldRule, oneWinner] = await service().createLuckyDrawEvents([
          eventInput(),
          {
            ...eventInput(),
            draw_mode: 'one_winner' as const,
            seed_nonce: 'nonce',
            seed_hash: 'hash',
          },
        ]);
        expect(oldRule.draw_mode).toBe('per_prize');
        expect(oldRule.seed_nonce).toBeNull();
        expect(oldRule.seed_hash).toBeNull();
        expect(oneWinner.draw_mode).toBe('one_winner');

        const [result] = await service().createLuckyDrawEventResults([
          eventResultInput(oneWinner.id),
        ]);
        expect(result.id).toMatch(/^lder_/);
        expect(result.winner_customer_id).toBeNull();
        expect(result.ticket_index).toBeNull();

        expect(
          await refusedBy(db(), INSERT_EVENT_RESULT, [
            'lder_second',
            oneWinner.id,
          ]),
        ).toBe('UQ_lucky_draw_event_result_event');
        await expect(
          service().createLuckyDrawEventResults([
            eventResultInput(oneWinner.id),
          ]),
        ).rejects.toThrow();
        // Another event has its own draw.
        expect(
          await refusedBy(db(), INSERT_EVENT_RESULT, [
            'lder_other',
            oldRule.id,
          ]),
        ).toBe('accepted');
      });

      it('up() leaves rows that predate it untouched, and down() puts the old shape back', async () => {
        const knex = db();
        const [pack] = await service().createPacks([packInput('schema-old')]);
        const [event] = await service().createLuckyDrawEvents([eventInput()]);

        await replay(knex, OneWinnerMigration.prototype, 'down');
        await replay(knex, TicketSpinMigration.prototype, 'down');

        // The old shape really is back: the old NOT NULL, no new tables or columns.
        expect(await isNullable('lucky_draw_entry', 'prize_id')).toBe('NO');
        expect(await isNullable('lucky_draw_entry', 'event_id')).toBeUndefined();
        expect(await isNullable('lucky_draw_event', 'draw_mode')).toBeUndefined();
        expect(await isNullable('pack', 'prize_type')).toBeUndefined();
        const { rows: gone } = await knex.raw(
          "SELECT to_regclass('ticket_prize') AS prize, to_regclass('ticket_spin') AS spin, to_regclass('lucky_draw_event_result') AS result",
        );
        expect(gone[0]).toEqual({ prize: null, spin: null, result: null });
        expect(
          await refusedBy(knex, INSERT_TICKET, [
            'ldtk_new',
            'cus_a',
            1,
            'pack_spin',
            'r',
          ]),
        ).toBe('lucky_draw_ticket_reason_check');

        // Rows written while the old shape is live, the way old code writes them.
        await knex.raw(INSERT_OLD_ENTRY, ['lden_old', 'ldpz_1', 'cus_a', 5]);
        await knex.raw(INSERT_TICKET, [
          'ldtk_old',
          'cus_a',
          5,
          'admin_grant',
          'admin:cus_a:1',
        ]);

        await replay(knex, TicketSpinMigration.prototype, 'up');
        await replay(knex, OneWinnerMigration.prototype, 'up');

        const { rows: entries } = await knex.raw(
          "SELECT prize_id, event_id, customer_id, tickets FROM lucky_draw_entry WHERE id = 'lden_old'",
        );
        expect(entries).toEqual([
          {
            prize_id: 'ldpz_1',
            event_id: null,
            customer_id: 'cus_a',
            tickets: 5,
          },
        ]);
        const { rows: tickets } = await knex.raw(
          "SELECT delta, reason, ref FROM lucky_draw_ticket WHERE id = 'ldtk_old'",
        );
        expect(tickets).toEqual([
          { delta: 5, reason: 'admin_grant', ref: 'admin:cus_a:1' },
        ]);
        const { rows: events } = await knex.raw(
          'SELECT draw_mode, seed_nonce, seed_hash FROM lucky_draw_event WHERE id = ?',
          [event.id],
        );
        expect(events).toEqual([
          { draw_mode: 'per_prize', seed_nonce: null, seed_hash: null },
        ]);
        const { rows: packs } = await knex.raw(
          'SELECT prize_type FROM pack WHERE id = ?',
          [pack.id],
        );
        expect(packs).toEqual([{ prize_type: 'cards' }]);

        // And the rules are back on after the replay.
        expect(
          await refusedBy(knex, INSERT_ENTRY, [
            'lden_both',
            'ldpz_1',
            'ldev_1',
            'cus_a',
            5,
          ]),
        ).toBe('lucky_draw_entry_one_target_check');
      });

      it('down() refuses while new-shape rows exist, and changes nothing', async () => {
        const knex = db();
        await service().createLuckyDrawTickets([
          { customer_id: 'cus_a', delta: 5, reason: 'pack_spin', ref: 'tksp_1' },
        ]);
        await expect(
          replay(knex, TicketSpinMigration.prototype, 'down'),
        ).rejects.toThrow(/refusing to unwind Migration20261030100000/);
        expect(await isNullable('pack', 'prize_type')).toBe('NO');

        const [entry] = await service().createLuckyDrawEntries([
          { event_id: 'ldev_1', customer_id: 'cus_a', tickets: 5 },
        ]);
        await expect(
          replay(knex, OneWinnerMigration.prototype, 'down'),
        ).rejects.toThrow(/refusing to unwind Migration20261030110000/);

        // A soft-deleted one still blocks: the NOT NULL would cover it too.
        await service().softDeleteLuckyDrawEntries([entry.id]);
        await expect(
          replay(knex, OneWinnerMigration.prototype, 'down'),
        ).rejects.toThrow(/refusing to unwind Migration20261030110000/);

        await knex.raw('DELETE FROM lucky_draw_entry WHERE id = ?', [entry.id]);
        await service().createLuckyDrawEvents([
          { ...eventInput(), draw_mode: 'one_winner' as const },
        ]);
        await expect(
          replay(knex, OneWinnerMigration.prototype, 'down'),
        ).rejects.toThrow(/refusing to unwind Migration20261030110000/);
        expect(await isNullable('lucky_draw_entry', 'event_id')).toBe('YES');
      });
    });
  },
});
