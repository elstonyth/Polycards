// integration-tests/http/account-self-service.spec.ts
// Permanent customer-initiated account deletion, end to end against a real
// server and a real database. (Disabling an account is an ADMIN action — see
// admin-disable.spec.ts; the only disable case here is the one that proves a
// banned account cannot delete itself out from under the ban.)
//
// This suite is the ONLY place on this branch where any of it runs for real.
// Every sibling unit spec fabricates its request object or mocks the service,
// so a handful of invariants are green there by construction rather than by
// evidence. Two in particular are provable only from here:
//
//  1. `rawLedgerBalanceCents`' SUM(ROUND(amount*100))::bigint has never run
//     against Postgres. The negative-balance leg of the delete-guards test is
//     what proves the sign survives the round trip, not just the JS.
//  2. The CUSTOMER-module half of the purge — the email scrub, the metadata
//     clear, the address delete and the notification delete. The unit spec
//     mocks those modules, so it can only assert that the route CALLED them
//     with a given shape; whether the rows are actually gone is knowable only
//     here. The notification rows matter most: they carry live password-reset
//     URLs and bank-account last4, and a soft delete would leave both in place.
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import type {
  ICustomerModuleService,
  INotificationModuleService,
} from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { CUSTOMER_FEED_CHANNEL } from '../../src/modules/packs/notify-feed';
import { seedOf } from '../../src/utils/profile-handle';
import { clearLeaderboardCache } from '../../src/api/store/leaderboard/route';
import { clearChallengeCache } from '../../src/api/store/challenge/route';
import { postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'account-self-service-pw-1'; // gitleaks:allow

/** The shipped admin-disable refusal copy, asserted verbatim (see below). */
const DISABLED_COPY = 'This account has been disabled. Please contact support.';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('customer self-service account deletion', () => {
      let storeHeaders: Record<string, string>;

      const packsOf = (): PacksModuleService =>
        getContainer().resolve<PacksModuleService>(PACKS_MODULE);

      /** Register → link the actor → log in. Only a LOGIN token carries a
       *  populated actor_id; a register token's is '' until POST
       *  /store/customers links the identity to a customer. */
      const register = async (
        email: string,
      ): Promise<{ id: string; token: string }> => {
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        const created = await postStoreCustomer(
          api,
          getContainer(),
          { email },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${reg.data.token}`,
            },
          },
        );
        const login = await api.post('/auth/customer/emailpass', {
          email,
          password: PASSWORD,
        });
        return { id: created.data.customer.id, token: login.data.token };
      };

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      const post = (path: string, body: unknown, token: string) =>
        unwrapResponse(api.post(path, body, { headers: authed(token) }));

      beforeEach(async () => {
        const apiKeyModule = getContainer().resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'account-self-service-test',
          type: 'publishable',
          created_by: 'account-self-service-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
        // Both public boards cache for 30s in module state, which outlives a
        // test's fixtures — the http suite runs in one process. These are the
        // purpose-built seams the sibling board specs already use.
        clearLeaderboardCache();
        clearChallengeCache();
      });

      // The security property behind admin disable: a banned account cannot
      // delete itself out from under the ban. The session guard is total, so
      // the request never reaches the route — which is exactly what must stay
      // true, because a delete that DID reach it would purge the payout details
      // and withdrawal counterparties the ban exists to preserve.
      it('an admin-disabled account cannot delete itself', async () => {
        const { id, token } = await register('admin-disabled@test.dev');
        const packs = packsOf();
        await packs.setAccountDisabled({
          customerId: id,
          adminId: 'admin_test',
          disabled: true,
          reason: 'support hold',
        });

        const res = await post(
          '/store/customers/me/delete',
          { password: PASSWORD },
          token,
        );
        expect(res.status).toBe(403);
        expect(res.data.message).toBe(DISABLED_COPY);
        expect(await packs.isAccountDisabled(id)).toBe(true);
      });

      it('a register-phase token (empty actor_id) is refused with 401', async () => {
        // Deliberately NOT linked with postStoreCustomer: until that runs the
        // JWT carries actor_id ''. The guard passes it through (no actor) and
        // the route itself must refuse it, so this pins the route's own check
        // rather than the guard's.
        const reg = await api.post('/auth/customer/emailpass/register', {
          email: 'register-token@test.dev',
          password: PASSWORD,
        });
        const res = await post(
          '/store/customers/me/delete',
          { password: PASSWORD },
          reg.data.token,
        );
        expect(res.status).toBe(401);
      });

      it('delete refuses a wrong password and a non-zero balance (both signs)', async () => {
        const { id, token } = await register('delete-guards@test.dev');
        const packs = packsOf();

        const wrongPw = await post(
          '/store/customers/me/delete',
          { password: 'not-the-password' },
          token,
        );
        expect(wrongPw.status).toBe(400);
        expect(wrongPw.data.message).toBe('PASSWORD_INCORRECT');

        await packs.mutateCreditAtomic({
          customerId: id,
          amount: 25,
          reason: 'adjustment',
        });
        const withBalance = await post(
          '/store/customers/me/delete',
          { password: PASSWORD },
          token,
        );
        expect(withBalance.status).toBe(400);
        expect(withBalance.data.message).toBe('BALANCE_NOT_ZERO');

        // The NEGATIVE direction, and the only place the signed SQL behind it
        // runs against Postgres at all. Written straight to the ledger rather
        // than through mutateCreditAtomic, whose floor of 0 would refuse the
        // debit before the delete guard ever saw it — a clawback gets there by
        // reversal, not by a floor-checked spend.
        await packs.createCreditTransactions([
          { customer_id: id, amount: -50, reason: 'adjustment' },
        ] as Parameters<typeof packs.createCreditTransactions>[0]);
        expect(await packs.rawLedgerBalanceCents(id)).toBe(-2500);

        const owing = await post(
          '/store/customers/me/delete',
          { password: PASSWORD },
          token,
        );
        expect(owing.status).toBe(400);
        expect(owing.data.message).toBe('BALANCE_NOT_ZERO');

        // Still fully usable — a refused delete must change nothing.
        const stillThere = await unwrapResponse(
          api.get('/store/credits', { headers: authed(token) }),
        );
        expect(stillThere.status).toBe(200);
        expect(await packs.isAccountDisabled(id)).toBe(false);
      });

      it('refuses a FROZEN account, and the balance read stays freeze-blind', async () => {
        const { id, token } = await register('delete-frozen@test.dev');
        const packs = packsOf();

        await packs.setManualFreeze({
          customerId: id,
          adminId: 'admin_test',
          reason: 'fraud review',
        });

        // At a ZERO balance the freeze is the only thing that can refuse this:
        // every other preflight check passes. It is also checked first, so this
        // is the reason the customer is given.
        const res = await post(
          '/store/customers/me/delete',
          { password: PASSWORD },
          token,
        );
        expect(res.status).toBe(400);
        expect(res.data.message).toBe('ACCOUNT_FROZEN');

        // And the property that outlives the ordering above: a frozen account
        // holding RM 25 must still read as holding it. availableBalance()
        // returns 0 for a frozen account, so "simplifying" the gate back to
        // that helper would sail this account through and strand real money.
        await packs.mutateCreditAtomic({
          customerId: id,
          amount: 25,
          reason: 'adjustment',
        });
        expect(await packs.availableBalance(id)).toBe(0);
        expect(await packs.rawLedgerBalanceCents(id)).toBe(2500);
      });

      it('delete purges the person, keeps the books, and frees the email', async () => {
        const email = 'delete-happy@test.dev';
        const { id, token } = await register(email);
        const packs = packsOf();

        // A settled withdrawal so there IS a retained financial row to inspect.
        await packs.createGlobePayWithdrawals([
          {
            merchant_transaction_id: `mt-delete-${id}`,
            customer_id: id,
            amount: 10,
            bank_code: 'MBB',
            account_number: '1234567890',
            account_holder_name: 'Real Person',
            status: 'settled',
          },
        ]);
        // A TERMINAL delivery (the preflight forbids any other kind at this
        // point), plus the two pure-PII tables, so the purge has something of
        // each kind to act on.
        await packs.createDeliveryOrders([
          {
            customer_id: id,
            status: 'completed',
            ship_name: 'Real Person',
            ship_address_1: '1 Real Road',
            ship_city: 'KL',
            ship_postal_code: '50000',
            ship_country_code: 'my',
            ship_phone: '+60123456789',
            // Cast because `proof_images` is a model.json() column whose
            // GENERATED type is Record<string, unknown>, while the column
            // deliberately holds a string[] (models/delivery-order.ts:37 — an
            // array so an update replaces it wholesale instead of merging).
            // The production writer stores the same shape, and the purge's
            // `proof_images = null` is what this fixture exists to prove.
            proof_images: ['https://example.test/doorstep.jpg'] as unknown as
              Record<string, unknown>,
          },
        ]);
        await packs.createPlayerPayoutDetails([
          {
            customer_id: id,
            bank_name: 'Maybank',
            bank_account_number: '1234567890',
            account_holder_name: 'Real Person',
          },
        ]);
        await packs.createNotificationReads([
          { customer_id: id, notification_id: 'noti_x' },
        ]);
        // The metadata blob is where the customer's personal data actually
        // lives — saved bank accounts, the public handle, the avatar id — and a
        // freshly registered row has metadata NULL, so "it is {} afterwards"
        // would be true whether or not the purge ran. Seed it so the assertion
        // has something to disprove.
        await packs.mutateCustomerMetadata({
          customerId: id,
          mutate: () => ({
            handle: 'realperson',
            avatar_url: 'https://example.test/avatar.png',
            bank_accounts: [
              { bank_name: 'Maybank', account_number: '1234567890' },
            ],
          }),
        });
        // Notification rows, under BOTH addressing conventions the route
        // queries: the EMAIL (transactional mail — the password-reset payload
        // carries a working reset URL) and the CUSTOMER ID (the in-app feed —
        // its payloads carry bank names and account last4). The route comment
        // warns against narrowing that filter back to the email alone, so both
        // halves get a row here.
        //
        // The CHANNEL is forced by the test environment — only the local
        // provider is registered without RESEND_*, so 'email' would throw "no
        // provider for channel". The ADDRESS is what the purge keys on, and the
        // address is what this fixture is testing.
        const customers =
          getContainer().resolve<ICustomerModuleService>(Modules.CUSTOMER);
        const notifications = getContainer().resolve<INotificationModuleService>(
          Modules.NOTIFICATION,
        );
        // A saved address — registration creates none, so without this the
        // "addresses are gone" assertion below would hold on an empty set.
        await customers.createCustomerAddresses([
          {
            customer_id: id,
            address_name: 'Home',
            first_name: 'Real',
            last_name: 'Person',
            address_1: '1 Real Road',
            city: 'KL',
            postal_code: '50000',
            country_code: 'my',
          },
        ]);
        await notifications.createNotifications([
          {
            to: email,
            channel: CUSTOMER_FEED_CHANNEL,
            template: 'password_reset',
            data: { url: 'https://example.test/reset?token=real-token' },
          },
          {
            to: id,
            receiver_id: id,
            channel: CUSTOMER_FEED_CHANNEL,
            template: 'bank_account_added',
            data: { bank_name: 'Maybank', account_last4: '7890' },
          },
        ]);
        // Asserted BEFORE the delete with the same filters used after it: a
        // filter that silently matched nothing would make the post-delete
        // "they are gone" checks pass on their own.
        expect(
          await notifications.listNotifications({ to: [email, id] }),
        ).toHaveLength(2);
        expect(
          await customers.listCustomerAddresses({ customer_id: id }),
        ).toHaveLength(1);
        // Net-zero credit movement, so the balance guard still passes while
        // leaving two credit_transaction rows that must SURVIVE.
        await packs.mutateCreditAtomic({
          customerId: id,
          amount: 25,
          reason: 'adjustment',
        });
        await packs.mutateCreditAtomic({
          customerId: id,
          amount: -25,
          reason: 'adjustment',
        });

        const res = await post(
          '/store/customers/me/delete',
          { password: PASSWORD },
          token,
        );
        expect(res.status).toBe(200);
        expect(res.data.deleted).toBe(true);

        // Login is gone for good — and reads as bad credentials, not "disabled".
        const relogin = await unwrapResponse(
          api.post('/auth/customer/emailpass', { email, password: PASSWORD }),
        );
        expect(relogin.status).toBe(401);

        // The bearer minted BEFORE the delete is still cryptographically valid
        // — JWT auth is pure verification with no DB lookup, and no
        // jwtExpiresIn is configured, so the framework default of a day
        // applies. The account-state tombstone is the only thing refusing it;
        // soft-deleting that row instead would make this 200.
        const zombie = await unwrapResponse(
          api.get('/store/credits', { headers: authed(token) }),
        );
        expect(zombie.status).toBe(403);

        // The books survive, scrubbed to the minimum.
        const [wd] = await packs.listGlobePayWithdrawals(
          { customer_id: id },
          { take: 1 },
        );
        expect(wd).toBeDefined();
        expect(Number(wd.amount)).toBe(10);
        expect(wd.status).toBe('settled');
        expect(wd.account_number).toBe('7890');
        expect(wd.account_holder_name).toBe('');

        const [delivery] = await packs.listDeliveryOrders(
          { customer_id: id },
          { take: 1 },
        );
        expect(delivery.status).toBe('completed'); // status is a book fact
        expect(delivery.ship_name).toBe('');
        expect(delivery.ship_address_1).toBe('');
        expect(delivery.ship_phone).toBeNull();
        // A doorstep photo can show the label or the recipient — the same PII
        // the ship_* scrub above removes.
        expect(delivery.proof_images).toBeNull();

        // Pure PII: gone outright.
        expect(
          await packs.listPlayerPayoutDetails({ customer_id: id }, { take: 1 }),
        ).toHaveLength(0);
        expect(
          await packs.listNotificationReads({ customer_id: id }, { take: 1 }),
        ).toHaveLength(0);

        // The CUSTOMER-module half of the purge, which every other spec on this
        // branch only mocks. `withDeleted` on both reads: the notification rows
        // must be HARD-deleted (a soft-deleted row keeps the reset URL and the
        // bank last4, which is the entire reason this step exists), and the
        // customer row is soft-deleted by step 7, so it is unreadable without
        // it.
        expect(
          await notifications.listNotifications(
            { to: [email, id] },
            { withDeleted: true },
          ),
        ).toHaveLength(0);
        const scrubbed = await customers.retrieveCustomer(id, {
          withDeleted: true,
        });
        expect(scrubbed.email.startsWith('deleted_')).toBe(true);
        expect(scrubbed.email).not.toContain(email);
        expect(scrubbed.first_name).toBeNull();
        expect(scrubbed.metadata).toEqual({});
        expect(
          await customers.listCustomerAddresses({ customer_id: id }),
        ).toHaveLength(0);

        // Retained untouched — the anonymous books.
        expect(
          await packs.listCreditTransactions({ customer_id: id }, { take: 10 }),
        ).toHaveLength(2);
        // The writer→reader join for this row is otherwise only static: nothing
        // else drives purgeAccountPacksData, and deletedCustomerIds keys the
        // post-delete accrual guards off exactly this audit row.
        const audits = await packs.listAdminActionAudits(
          { entity_id: id },
          { take: 10 },
        );
        expect(audits.some((a) => a.action === 'delete_account')).toBe(true);
        expect(await packs.deletedCustomerIds([id])).toEqual(new Set([id]));

        // That read is deliberately UNBOUNDED, and this is the shape that
        // proves it: two delete_account rows for one customer plus a second
        // deleted id. Under the old `take: customerIds.length` the third row
        // falls off the end and the returned set omits a deleted account —
        // which then gets paid, forever. The purge's idempotency guard means a
        // duplicate can only arrive from a hand-finished purge, so it is
        // written by hand here. `ghost` needs no customer row: this read only
        // ever touches admin_action_audit.
        const ghost = `cus_ghost_${id}`;
        await packs.createAdminActionAudits([
          {
            admin_id: id,
            entity_type: 'customer',
            entity_id: id,
            action: 'delete_account',
            before: { deleted: false },
            after: { deleted: true },
            reason: 'Second attempt at a hand-finished purge.',
          },
          {
            admin_id: ghost,
            entity_type: 'customer',
            entity_id: ghost,
            action: 'delete_account',
            before: { deleted: false },
            after: { deleted: true },
            reason: 'Customer deleted their own account.',
          },
        ]);
        expect(await packs.deletedCustomerIds([id, ghost])).toEqual(
          new Set([id, ghost]),
        );

        // The email is reusable — this is what proves the auth identities were
        // HARD-deleted. (provider_identity's unique index has no deleted_at
        // predicate, so a soft delete would 23505 here forever.)
        const again = await unwrapResponse(
          api.post('/auth/customer/emailpass/register', {
            email,
            password: PASSWORD,
          }),
        );
        expect(again.status).toBe(200);
      });

      // Spec §4. The `pull` rows are retained by design, so a deleted customer
      // can still be ranked on a PUBLIC board. `publicProfileFields` is already
      // undefined-safe, which is exactly why this needs a test: nothing else
      // would stop a future refactor turning the first real delete into a 500
      // on the leaderboard, and that page is the one nobody is logged in to.
      it('renders a deleted-but-ranked player anonymously on the public boards', async () => {
        const email = 'delete-ranked@test.dev';
        const { id, token } = await register(email);
        const packs = packsOf();

        // A BOUGHT-BACK pull: it still counts toward the week's pulled value
        // (challengeWeekTop filters on rolled_at and source, never status) but
        // does not trip CARDS_UNSETTLED, which blocks only 'vaulted' /
        // 'delivering'. `source` is left at its 'pack' default on purpose — a
        // 'reward' row is excluded from both boards.
        await packs.createPulls([
          {
            customer_id: id,
            pack_id: 'db-pack',
            card_id: 'db-charizard',
            rolled_at: new Date(),
            status: 'bought_back',
          },
        ]);

        const del = await post(
          '/store/customers/me/delete',
          { password: PASSWORD },
          token,
        );
        expect(del.status).toBe(200);

        // No auth header: these are the anonymous surfaces.
        for (const path of [
          '/store/leaderboard?period=weekly',
          '/store/challenge',
        ]) {
          const page = await unwrapResponse(
            api.get(path, { headers: storeHeaders }),
          );
          expect(page.status).toBe(200);
          expect(JSON.stringify(page.data)).not.toContain(email);
        }

        const board = await unwrapResponse(
          api.get('/store/leaderboard?period=weekly', {
            headers: storeHeaders,
          }),
        );
        const entry = (
          board.data.entries as { seed: number; name: string }[]
        ).find((e) => e.seed === seedOf(id));
        expect(entry).toBeDefined();
        // Exact, not /^Collector \d{4}$/: seedOf is a 32-bit hash whose decimal
        // form is not guaranteed to be 4+ digits, and a loose pattern would
        // fail for reasons that have nothing to do with deletion.
        expect(entry?.name).toBe(`Collector ${String(seedOf(id)).slice(0, 4)}`);
      });
    });
  },
});
