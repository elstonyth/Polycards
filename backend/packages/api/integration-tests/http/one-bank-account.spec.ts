import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import jwt from 'jsonwebtoken';
import { PACKS_MODULE } from '../../src/modules/packs';
import { savedBankAccountId } from '../../src/modules/packs/saved-accounts';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// One bank account per Polycards account, one Polycards account per bank account
// (ADR 0015), through the real routes and the real SQL. Details are made up.
// A bank is saved in the account's real name, never a typed one (owner,
// 2026-11-16), so each customer here has a real name of their own.

const NUMBER = '512345678901';
const ACCOUNT_ID = savedBankAccountId('MBBEMYKL', NUMBER);
const ACCOUNTS = '/store/credits/withdraw/accounts';
const save = (number = NUMBER) => ({
  bank_code: 'MBBEMYKL',
  account_number: number,
});

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('one bank account', () => {
      let adminToken: string;
      let storeHeaders: Record<string, string>;

      beforeEach(async () => {
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          'one-bank-admin@test.dev',
          'one-bank-test-password-1',
        );
        const key = await getContainer()
          .resolve(Modules.API_KEY)
          .createApiKeys({
            title: 'one-bank-test',
            type: 'publishable',
            created_by: 'one-bank-test',
          });
        storeHeaders = { 'x-publishable-api-key': key.token };
      });

      const packs = () =>
        getContainer().resolve<PacksModuleService>(PACKS_MODULE);

      // A real name of its own by default (one per account, ADR 0015); null
      // for none, or a name another account holds, set as support sets it.
      const newCustomer = async (
        email: string,
        realName: string | null = `Holder ${email.split('@')[0].replace(/[^a-z]/g, ' ')}`,
      ): Promise<string> => {
        const [customer] = await getContainer()
          .resolve(Modules.CUSTOMER)
          .createCustomers([{ email, has_account: true }]);
        if (realName) {
          await packs().adminSetRealName({
            customerId: customer.id,
            adminId: 'user_test',
            realName,
            reason: 'test',
          });
        }
        return customer.id;
      };

      const asCustomer = (id: string) => {
        const { jwtSecret } =
          getContainer().resolve('configModule').projectConfig.http;
        const token = jwt.sign(
          {
            actor_id: id,
            actor_type: 'customer',
            auth_identity_id: `authid_${id}`,
            app_metadata: { customer_id: id },
          },
          jwtSecret as string,
          { expiresIn: '1h' },
        );
        return {
          headers: { ...storeHeaders, authorization: `Bearer ${token}` },
        };
      };
      const asAdmin = () => ({
        headers: { authorization: `Bearer ${adminToken}` },
      });

      const accounts = async (id: string) =>
        (await unwrapResponse(api.get(ACCOUNTS, asCustomer(id)))).data
          .accounts as {
          id: string;
          unavailableReason?: string;
        }[];
      const card = async (id: string) =>
        (
          await unwrapResponse(
            api.get(`/admin/customers/${id}/bank-accounts`, asAdmin()),
          )
        ).data;
      const verify = (id: string, verified = true) =>
        unwrapResponse(
          api.post(
            `/admin/customers/${id}/bank-accounts/verify`,
            { account_id: ACCOUNT_ID, verified, reason: 'checked' },
            asAdmin(),
          ),
        );

      it('a customer can save one, and cannot remove it or add another', async () => {
        const a = await newCustomer('one-bank-a@test.dev');
        const first = await unwrapResponse(
          api.post(ACCOUNTS, save(), asCustomer(a)),
        );
        expect(first.status).toBe(200);

        const second = await unwrapResponse(
          api.post(ACCOUNTS, save('512345678902'), asCustomer(a)),
        );
        expect(second.status).toBe(400);
        expect(second.data.message).toMatch(/already has a bank account/);

        const del = await unwrapResponse(
          api.delete(ACCOUNTS, {
            ...asCustomer(a),
            data: { id: ACCOUNT_ID },
          }),
        );
        expect(del.status).toBe(400);
        expect(await accounts(a)).toHaveLength(1);
      });

      it('a number on another account is refused, whatever the name', async () => {
        const a = await newCustomer('one-bank-b@test.dev');
        const b = await newCustomer('one-bank-c@test.dev');
        await unwrapResponse(api.post(ACCOUNTS, save(), asCustomer(a)));
        const res = await unwrapResponse(
          api.post(ACCOUNTS, save(NUMBER), asCustomer(b)),
        );
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/linked to another/);
        expect(await accounts(b)).toEqual([]);
      });

      it('a shared number holds both accounts until support acts on each', async () => {
        const a = await newCustomer('one-bank-d@test.dev');
        const b = await newCustomer('one-bank-e@test.dev');
        await unwrapResponse(api.post(ACCOUNTS, save(), asCustomer(a)));
        // How the old clusters look: written before the rule, so not through a save.
        await getContainer()
          .resolve(Modules.CUSTOMER)
          .updateCustomers(b, {
            metadata: {
              bank_accounts: [
                {
                  id: ACCOUNT_ID,
                  bankCode: 'MBBEMYKL',
                  bankName: 'Maybank',
                  accountNumber: NUMBER,
                  accountHolderName: 'Other Name',
                  savedAt: '2026-01-01T00:00:00.000Z',
                },
              ],
            },
          });

        expect((await accounts(a))[0].unavailableReason).toMatch(
          /linked to another/,
        );
        expect((await accounts(b))[0].unavailableReason).toMatch(
          /linked to another/,
        );
        expect((await card(a)).accounts[0].linked).toEqual([
          expect.objectContaining({ customer_id: b }),
        ]);

        // Verify lifts it for that account only, and only one can be verified.
        expect((await verify(a)).status).toBe(200);
        expect((await accounts(a))[0].unavailableReason).toBeUndefined();
        expect((await accounts(b))[0].unavailableReason).toMatch(
          /linked to another/,
        );
        const refused = await verify(b);
        expect(refused.status).toBe(400);
        expect(refused.data.message).toMatch(/already verified/);

        // Removal clears the stamp. A was never paid to it, so once it is off A's
        // list B is the only holder, and B's hold lifts with nothing to verify.
        const removed = await unwrapResponse(
          api.post(
            `/admin/customers/${a}/bank-accounts/remove`,
            { account_id: ACCOUNT_ID, reason: 'not theirs' },
            asAdmin(),
          ),
        );
        expect(removed.status).toBe(200);
        const after = await card(a);
        expect(after.accounts).toEqual([]);
        expect((await accounts(b))[0].unavailableReason).toBeUndefined();

        const audits = await packs().listAdminActionAudits({ entity_id: a });
        expect(audits.map((r) => r.reason)).toEqual(
          expect.arrayContaining([
            'Verified shared bank account: checked',
            'Removed saved bank account: not theirs',
          ]),
        );
        expect(JSON.stringify(audits)).not.toContain(NUMBER);
      });

      it('support can add a number a customer save refuses, and it arrives verified', async () => {
        const paid = await newCustomer('one-bank-f@test.dev');
        const owner = await newCustomer('one-bank-g@test.dev');
        await packs().createGatewayWithdrawals([
          {
            merchant_transaction_id: 'one-bank-wd-1',
            customer_id: paid,
            amount: 100,
            amount_settled: 100,
            bank_code: 'MBBEMYKL',
            account_number: NUMBER,
            account_holder_name: 'Old Name',
            status: 'settled',
            settled_at: new Date(),
          },
        ]);

        const self = await unwrapResponse(
          api.post(ACCOUNTS, save(), asCustomer(owner)),
        );
        expect(self.status).toBe(400);

        const added = await unwrapResponse(
          api.post(
            `/admin/customers/${owner}/bank-accounts/add`,
            { ...save(), reason: 'owner proved it' },
            asAdmin(),
          ),
        );
        expect(added.status).toBe(200);
        expect((await card(owner)).accounts[0].verified_at).toEqual(
          expect.any(String),
        );
        expect((await accounts(owner))[0].unavailableReason).toBeUndefined();
      });

      it('finds a holder through zero padding, but not a scrubbed last-4 row', async () => {
        const holder = await newCustomer('one-bank-h@test.dev');
        await packs().createGatewayWithdrawals([
          {
            merchant_transaction_id: 'one-bank-wd-2',
            customer_id: holder,
            amount: 100,
            amount_settled: 100,
            bank_code: 'MBBEMYKL',
            account_number: `00${NUMBER}`,
            account_holder_name: 'Padded',
            status: 'settled',
            settled_at: new Date(),
          },
          {
            merchant_transaction_id: 'one-bank-wd-3',
            customer_id: holder,
            amount: 100,
            amount_settled: 100,
            bank_code: 'SCBLMYKX',
            account_number: '1234',
            account_holder_name: 'Scrubbed',
            status: 'settled',
            settled_at: new Date(),
          },
        ]);
        const holders = async (bankCode: string, accountNumber: string) =>
          (
            await packs().payoutNumberStanding('cus_other', {
              bankCode,
              accountNumber,
            })
          ).holders.map((h) => h.customerId);
        expect(await holders('MBBEMYKL', NUMBER)).toEqual([holder]);
        expect(await holders('SCBLMYKX', '01234')).toEqual([]);
      });

      it('the admin customer routes cannot write the stamp or blank the blob', async () => {
        const a = await newCustomer('one-bank-i@test.dev');
        const stamp = await unwrapResponse(
          api.post(
            `/admin/customers/${a}`,
            { metadata: { bank_share_verified: { [ACCOUNT_ID]: 'x' } } },
            asAdmin(),
          ),
        );
        expect(stamp.status).toBe(400);
        const blank = await unwrapResponse(
          api.post(`/admin/customers/${a}`, { metadata: null }, asAdmin()),
        );
        expect(blank.status).toBe(400);
        const create = await unwrapResponse(
          api.post(
            '/admin/customers',
            {
              email: 'one-bank-j@test.dev',
              metadata: { bank_share_verified: { [ACCOUNT_ID]: 'x' } },
            },
            asAdmin(),
          ),
        );
        expect(create.status).toBe(400);
      });

      // Owner, 2026-11-03: banned numbers, one name per person at any bank,
      // one account per currency. Owner, 2026-11-16: the name is the real name.
      it('saves a bank in the real name, drops a typed one, and refuses without one', async () => {
        const a = await newCustomer('one-bank-k@test.dev', 'Test  Holder Kay');
        const ok = await unwrapResponse(
          api.post(
            ACCOUNTS,
            {
              ...save(),
              account_holder_name: 'Someone Else',
              account_holder_name_confirm: 'Another Name',
            },
            asCustomer(a),
          ),
        );
        expect(ok.status).toBe(200);
        expect(ok.data.accounts[0].accountHolderName).toBe('Test Holder Kay');

        const none = await newCustomer('one-bank-w@test.dev', null);
        const refused = await unwrapResponse(
          api.post(ACCOUNTS, save('512345678912'), asCustomer(none)),
        );
        expect(refused.status).toBe(400);
        expect(refused.data.message).toMatch(/real name/);
        const byStaff = await unwrapResponse(
          api.post(
            `/admin/customers/${none}/bank-accounts/add`,
            { ...save('512345678912'), reason: 'try' },
            asAdmin(),
          ),
        );
        expect(byStaff.status).toBe(400);
        expect(byStaff.data.message).toMatch(/no real name on file/);
        expect(await accounts(none)).toEqual([]);
      });

      it('support correcting the real name carries it to the bank in the old name', async () => {
        const a = await newCustomer('one-bank-x@test.dev', 'Tset Holder');
        await unwrapResponse(api.post(ACCOUNTS, save(), asCustomer(a)));
        const fixed = await unwrapResponse(
          api.post(
            `/admin/customers/${a}/real-name`,
            { real_name: 'Test Holder', reason: 'typo, checked' },
            asAdmin(),
          ),
        );
        expect(fixed.status).toBe(200);
        expect((await card(a)).accounts[0].account_holder_name).toBe(
          'Test Holder',
        );
        const [audit] = await packs().listAdminActionAudits({
          entity_id: a,
          action: 'set_real_name',
          reason: 'typo, checked',
        });
        expect(audit.after).toMatchObject({
          real_name: 'Test Holder',
          bank_holders: [expect.objectContaining({ holder: 'Test Holder' })],
        });
      });

      it('support unbans a number for one player; it stays banned for the others', async () => {
        const a = await newCustomer('one-bank-u@test.dev');
        const b = await newCustomer('one-bank-v@test.dev');
        const pg = getContainer().resolve(ContainerRegistrationKeys.PG_CONNECTION);
        await pg.raw(
          'INSERT INTO banned_payout_account (account_key, bank_code, reason) VALUES (?, ?, ?)',
          ['512345678911', 'MBBEMYKL', 'test'],
        );
        // a's save was refused: the number is on no list of a's.
        const refused = await unwrapResponse(
          api.post(ACCOUNTS, save('512345678911'), asCustomer(a)),
        );
        expect(refused.status).toBe(400);
        expect(refused.data.message).toMatch(/cannot be used/);
        const res = await unwrapResponse(
          api.post(
            `/admin/customers/${a}/bank-accounts/unban-number`,
            { last4: '8911', reason: 'owner approved' },
            asAdmin(),
          ),
        );
        expect(res.status).toBe(200);
        expect(res.data).toMatchObject({ lifted: true, changed: true });
        const saved = await unwrapResponse(
          api.post(ACCOUNTS, save('512345678911'), asCustomer(a)),
        );
        expect(saved.status).toBe(200);
        const listed = await unwrapResponse(
          api.get(`/admin/customers/${a}/bank-accounts`, asAdmin()),
        );
        expect(listed.data.banned_numbers).toEqual([
          expect.objectContaining({ last4: '8911', lifted_for_player: true }),
        ]);
        // Still banned for everyone else.
        const other = await unwrapResponse(
          api.post(ACCOUNTS, save('512345678911'), asCustomer(b)),
        );
        expect(other.status).toBe(400);
        expect(other.data.message).toMatch(/cannot be used/);
      });

      it('refuses a banned number at any bank, for support too', async () => {
        const a = await newCustomer('one-bank-l@test.dev');
        await getContainer()
          .resolve(ContainerRegistrationKeys.PG_CONNECTION)
          .raw(
            'INSERT INTO banned_payout_account (account_key, bank_code, reason) VALUES (?, ?, ?)',
            ['512345678903', 'PBBEMYKL', 'test'],
          );
        const res = await unwrapResponse(
          api.post(ACCOUNTS, save('512345678903'), asCustomer(a)),
        );
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/cannot be used/);
        const added = await unwrapResponse(
          api.post(
            `/admin/customers/${a}/bank-accounts/add`,
            { ...save('512345678903'), reason: 'try' },
            asAdmin(),
          ),
        );
        expect(added.status).toBe(400);
        expect(await accounts(a)).toEqual([]);
      });

      it('refuses a name another account used, saved or paid, at another bank', async () => {
        const a = await newCustomer('one-bank-m@test.dev', 'Ring Name');
        // Support may set a name another account holds (two real people).
        const b = await newCustomer('one-bank-n@test.dev', 'RING  name');
        const c = await newCustomer('one-bank-o@test.dev', 'Paid Name');
        await unwrapResponse(
          api.post(ACCOUNTS, save('512345678904'), asCustomer(a)),
        );
        const saved = await unwrapResponse(
          api.post(
            ACCOUNTS,
            { ...save('7012345678'), bank_code: 'CIBBMYKL' },
            asCustomer(b),
          ),
        );
        expect(saved.status).toBe(400);
        expect(saved.data.message).toMatch(/name is already linked/);

        await packs().createGatewayWithdrawals([
          {
            merchant_transaction_id: 'one-bank-wd-4',
            customer_id: a,
            amount: 100,
            amount_settled: 100,
            bank_code: 'PBBEMYKL',
            account_number: '6012345678',
            account_holder_name: 'Paid Name',
            status: 'settled',
            settled_at: new Date(),
          },
        ]);
        const paid = await unwrapResponse(
          api.post(ACCOUNTS, save('512345678905'), asCustomer(c)),
        );
        expect(paid.status).toBe(400);
        expect(paid.data.message).toMatch(/name is already linked/);
      });

      it('lifting a permanent ban clears the saved banks, a staff disable keeps them', async () => {
        const a = await newCustomer('one-bank-q@test.dev');
        await unwrapResponse(
          api.post(
            ACCOUNTS,
            save('512345678907'),
            asCustomer(a),
          ),
        );
        await packs().setAccountDisabled({
          customerId: a,
          adminId: 'user_test',
          disabled: true,
          reason:
            'Permanent ban: shared bank account, more than one account (owner, 2026-11-03)',
        });
        const lifted = await unwrapResponse(
          api.post(
            `/admin/customers/${a}/enable`,
            { reason: 'owner approved' },
            asAdmin(),
          ),
        );
        expect(lifted.status).toBe(200);
        expect(lifted.data).toMatchObject({
          disabled: false,
          cleared_bank_accounts: 1,
        });
        expect(await accounts(a)).toEqual([]);
        expect(await packs().isAccountDisabled(a)).toBe(false);

        const b = await newCustomer('one-bank-r@test.dev');
        await unwrapResponse(
          api.post(
            ACCOUNTS,
            save('512345678908'),
            asCustomer(b),
          ),
        );
        await packs().setAccountDisabled({
          customerId: b,
          adminId: 'user_test',
          disabled: true,
          reason: 'chargeback check',
        });
        const enabled = await unwrapResponse(
          api.post(
            `/admin/customers/${b}/enable`,
            { reason: 'checked' },
            asAdmin(),
          ),
        );
        expect(enabled.data).toEqual({ disabled: false });
        expect(await accounts(b)).toHaveLength(1);
      });

      it('one account per currency: an RM bank and a USDT wallet both fit', async () => {
        const a = await newCustomer('one-bank-p@test.dev');
        await unwrapResponse(
          api.post(
            ACCOUNTS,
            save('512345678906'),
            asCustomer(a),
          ),
        );
        const wallet = await unwrapResponse(
          api.post(
            ACCOUNTS,
            {
              bank_code: 'USDTTRC20',
              account_number: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
            },
            asCustomer(a),
          ),
        );
        expect(wallet.status).toBe(200);
        expect(await accounts(a)).toHaveLength(2);
      });

      it("Touch 'n Go has its own slot beside the RM bank, under the same name", async () => {
        const a = await newCustomer('one-bank-q@test.dev');
        const tng = (number: string) => ({
          ...save(number),
          bank_code: 'TNGMY',
        });
        await unwrapResponse(
          api.post(ACCOUNTS, save('512345678907'), asCustomer(a)),
        );
        // The linked-name rule reads other accounts only: the owner's own
        // bank under that name does not block the Touch 'n Go.
        const first = await unwrapResponse(
          api.post(ACCOUNTS, tng('120000000007'), asCustomer(a)),
        );
        expect(first.status).toBe(200);
        expect(await accounts(a)).toHaveLength(2);
        const second = await unwrapResponse(
          api.post(ACCOUNTS, tng('120000000008'), asCustomer(a)),
        );
        expect(second.status).toBe(400);
        expect(second.data.message).toMatch(
          /already has a Touch 'n Go account/,
        );
        expect(await accounts(a)).toHaveLength(2);
      });

      it('support clears a name two real people share, for each account on its own', async () => {
        const a = await newCustomer('one-bank-s@test.dev', 'Shared Name');
        const b = await newCustomer('one-bank-t@test.dev', 'Shared Name');
        await unwrapResponse(
          api.post(ACCOUNTS, save('512345678909'), asCustomer(a)),
        );
        const refused = await unwrapResponse(
          api.post(ACCOUNTS, save('512345678910'), asCustomer(b)),
        );
        expect(refused.status).toBe(400);
        expect(refused.data.message).toMatch(/already linked to another/);
        const cleared = await unwrapResponse(
          api.post(
            `/admin/customers/${b}/bank-accounts/name-clash`,
            { holder_name: 'SHARED NAME', cleared: true, reason: 'two people' },
            asAdmin(),
          ),
        );
        expect(cleared.status).toBe(200);
        const saved = await unwrapResponse(
          api.post(ACCOUNTS, save('512345678910'), asCustomer(b)),
        );
        expect(saved.status).toBe(200);
        expect(await accounts(b)).toHaveLength(1);
        // The customer's own record never carries support's note: it names the
        // other account. Its metadata is served (the saved list is there).
        const me = await unwrapResponse(
          api.get('/store/customers/me', asCustomer(b)),
        );
        expect(me.status).toBe(200);
        expect(me.data.customer.metadata).toHaveProperty('bank_accounts');
        expect(me.data.customer.metadata).not.toHaveProperty(
          'holder_name_cleared',
        );
      });

      it("a Touch 'n Go is refused while a saved bank is in another name than the real name", async () => {
        const a = await newCustomer('one-bank-r@test.dev', 'Slot Owner');
        // An older bank, saved before the holder was the real name.
        await getContainer()
          .resolve(Modules.CUSTOMER)
          .updateCustomers(a, {
            metadata: {
              bank_accounts: [
                {
                  id: savedBankAccountId('MBBEMYKL', '512345678908'),
                  bankCode: 'MBBEMYKL',
                  bankName: 'Maybank',
                  accountNumber: '512345678908',
                  accountHolderName: 'Another Person',
                  savedAt: '2026-01-01T00:00:00.000Z',
                },
              ],
            },
          });
        const other = await unwrapResponse(
          api.post(
            ACCOUNTS,
            { ...save('120000000009'), bank_code: 'TNGMY' },
            asCustomer(a),
          ),
        );
        expect(other.status).toBe(400);
        expect(other.data.message).toMatch(/another name than your real name/);
        expect(await accounts(a)).toHaveLength(1);
      });
    });
  },
});
