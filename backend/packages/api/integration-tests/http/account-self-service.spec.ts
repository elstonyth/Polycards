// integration-tests/http/account-self-service.spec.ts
// The customer-facing account lifecycle, end to end against a real server and a
// real database: self-disable → reactivate, and permanent deletion.
//
// This suite is the ONLY place on this branch where any of it runs for real.
// Every sibling unit spec fabricates its request object or mocks the service,
// so a handful of invariants are green there by construction rather than by
// evidence. Two in particular are provable only from here:
//
//  1. The session guard's reactivate carve-out matches on a normalized
//     `req.originalUrl`. A unit test cannot produce that value: the guard is
//     registered as a method-less '/store/*' `app.use` entry, where Express has
//     already stripped the matched prefix and `req.path` is '/'. The
//     "self-disabled bearer reaches POST /reactivate → 200" case below is the
//     only check in the plan that can catch a mistake there — and the cost of
//     that mistake is total: /disable needs no password, so a stolen token
//     would brick the account with no way back in.
//  2. `rawLedgerBalanceCents`' SUM(ROUND(amount*100))::bigint has never run
//     against Postgres. The negative-balance leg of the delete-guards test is
//     what proves the sign survives the round trip, not just the JS.
//  3. The CUSTOMER-module half of the purge — the email scrub, the metadata
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
const SELF_DISABLED_CODE = 'ACCOUNT_SELF_DISABLED';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('customer self-service disable / delete', () => {
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

      it('disable → login still works → other routes 403 → reactivate → normal', async () => {
        const { id, token } = await register('self-disable@test.dev');
        const packs = packsOf();

        const disabled = await post('/store/customers/me/disable', {}, token);
        expect(disabled.status).toBe(200);
        expect(await packs.accountDisabledCause(id)).toBe('self');

        // A self-disable must NOT block the token exchange — the password has to
        // be provable before reactivation is offered.
        const relogin = await unwrapResponse(
          api.post('/auth/customer/emailpass', {
            email: 'self-disable@test.dev',
            password: PASSWORD,
          }),
        );
        expect(relogin.status).toBe(200);
        const freshToken = relogin.data.token;

        // Everything else is closed, with the machine-readable code.
        const blocked = await unwrapResponse(
          api.get('/store/credits', { headers: authed(freshToken) }),
        );
        expect(blocked.status).toBe(403);
        expect(blocked.data.message).toBe(SELF_DISABLED_CODE);

        // THE STOREFRONT'S DETECTION CONTRACT. Both halves are load-bearing and
        // neither is provable by a mocked unit test, which is why they are here.
        //
        // First: GET /store/customers/me answers 200 for a self-disabled
        // session. That is deliberate (the account layout needs it, or /settings
        // bounces and the Delete button becomes unreachable) — but it means
        // login SUCCEEDS for a self-disabled customer and nothing on the login
        // path throws. An earlier plan for the reactivate prompt hung off a
        // rejection here; this assertion is what makes that impossible to
        // re-introduce by accident.
        const me = await unwrapResponse(
          api.get('/store/customers/me', { headers: authed(freshToken) }),
        );
        expect(me.status).toBe(200);

        // Second: because that read cannot fail, the disable is reported as
        // DATA on the account route instead. This is the only signal login has.
        const info = await unwrapResponse(
          api.get('/store/customers/me/account', {
            headers: authed(freshToken),
          }),
        );
        expect(info.status).toBe(200);
        expect(info.data.disabledCause).toBe('self');

        // A repeat /disable never reaches its handler: the same guard that
        // opens /reactivate closes this. Asserted as the NEGATIVE twin of the
        // carve-out below — together they prove the originalUrl match in both
        // directions, which is what makes the pair conclusive rather than a
        // guard that happens to allow everything.
        const again = await post('/store/customers/me/disable', {}, freshToken);
        expect(again.status).toBe(403);
        expect(again.data.message).toBe(SELF_DISABLED_CODE);

        // THE load-bearing case. See the file header.
        const reactivated = await post(
          '/store/customers/me/reactivate',
          {},
          freshToken,
        );
        expect(reactivated.status).toBe(200);
        expect(await packs.accountDisabledCause(id)).toBeNull();

        // The whole disable record is cleared, not just the boolean — a stale
        // disabled_cause would make the next self-disable's carve-out decision
        // read from a lifted ban.
        const [state] = await packs.listCustomerAccountStates(
          { customer_id: id },
          { take: 1 },
        );
        expect(state.disabled).toBe(false);
        expect(state.disabled_cause).toBeNull();
        expect(state.disabled_at).toBeNull();
        expect(state.disabled_by).toBeNull();

        // The lift is disclosed: state and audit share one transaction.
        const audits = await packs.listAdminActionAudits(
          { entity_id: id },
          { take: 10 },
        );
        expect(audits.some((a) => a.action === 'enable')).toBe(true);

        const open = await unwrapResponse(
          api.get('/store/credits', { headers: authed(freshToken) }),
        );
        expect(open.status).toBe(200);
      });

      // The spec originally said 403 here; the spec was wrong and was corrected
      // (commit d55ae273). An admin can re-enable between the login prompt and
      // the customer's reactivate confirm, and answering that race with an
      // error would strand a customer whose account is already fine.
      it('reactivate on an account that is NOT disabled is an idempotent 200', async () => {
        const { id, token } = await register('reactivate-noop@test.dev');

        const res = await post('/store/customers/me/reactivate', {}, token);
        expect(res.status).toBe(200);
        expect(res.data.disabled).toBe(false);
        expect(await packsOf().accountDisabledCause(id)).toBeNull();
      });

      it('an admin-disabled account cannot self-reactivate OR self-disable', async () => {
        const { id, token } = await register('admin-disabled@test.dev');
        const packs = packsOf();
        await packs.setAccountDisabled({
          customerId: id,
          adminId: 'admin_test',
          disabled: true,
          reason: 'support hold',
          cause: 'admin',
        });

        // Both routes, because the carve-out set is consulted ONLY on the
        // 'self' branch — the admin branch stays total. A delete reaching the
        // route would purge the payout details and withdrawal counterparties
        // the ban exists to preserve.
        for (const path of [
          '/store/customers/me/reactivate',
          '/store/customers/me/disable',
          '/store/customers/me/delete',
        ]) {
          const res = await post(path, { password: PASSWORD }, token);
          expect(res.status).toBe(403);
          expect(res.data.message).toBe(DISABLED_COPY);
        }
        expect(await packs.accountDisabledCause(id)).toBe('admin');
      });

      it('a register-phase token (empty actor_id) is refused with 401', async () => {
        // Deliberately NOT linked with postStoreCustomer: until that runs the
        // JWT carries actor_id ''. The guard passes it through (no actor) and
        // the routes themselves must refuse it, so this pins the routes' own
        // check rather than the guard's.
        const reg = await api.post('/auth/customer/emailpass/register', {
          email: 'register-token@test.dev',
          password: PASSWORD,
        });
        for (const path of [
          '/store/customers/me/disable',
          '/store/customers/me/reactivate',
          '/store/customers/me/delete',
        ]) {
          const res = await post(path, { password: PASSWORD }, reg.data.token);
          expect(res.status).toBe(401);
        }
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
        expect(await packs.accountDisabledCause(id)).toBeNull();
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
