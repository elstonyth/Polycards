import { A3PAY_NOT_FOUND, getPayinDetail, getPayoutDetail, checkAccBalance } from '../a3pay-client';
import { generateKeyPairSync } from 'node:crypto';

// Response shapes measured live against A3Pay production on 2026-10-12.
const ours = generateKeyPairSync('rsa', {
  modulusLength: 1024,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'der' },
});
const config = {
  kind: 'a3pay' as const,
  baseUrl: 'https://mapi.example.test',
  merchantCode: 'polycards',
  aesKey: 'k',
  privateKey: ours.privateKey.toString('base64'),
  publicKey: ours.publicKey.toString('base64'),
  currencyCode: 'SGD',
};

function reply(status: number, body: string) {
  global.fetch = jest.fn().mockResolvedValue({
    status,
    text: async () => body,
  }) as unknown as typeof fetch;
}

const NOT_FOUND =
  '{"isSuccess":false,"successCode":0,"errorCode":null,"errorMessage":"Not found","errorList":null,"data":null}';

describe('A3Pay live response shapes', () => {
  it('tags "Not found" on a payin or payout requery as definite not-found', async () => {
    for (const call of [getPayinDetail, getPayoutDetail]) {
      reply(400, NOT_FOUND);
      await expect(call('PC-x', config)).rejects.toMatchObject({
        definite: true,
        codes: [A3PAY_NOT_FOUND],
      });
    }
  });

  it('a wrong AES key (plain-text 400) is never not-found', async () => {
    reply(400, 'Invalid Request');
    const error = await getPayinDetail('PC-x', config).catch((e) => e);
    expect(error.codes).toEqual([]);
    expect(error.definite).toBe(false);
  });

  it('a wrong merchant code (403 problem+json) is never not-found', async () => {
    reply(403, '{"title":"Forbidden","status":403}');
    const error = await getPayoutDetail('PC-x', config).catch((e) => e);
    expect(error.codes).toEqual([]);
    expect(error.definite).toBe(false);
  });

  it('"Not found" from a NON-requery endpoint is not tagged', async () => {
    reply(400, NOT_FOUND);
    const error = await checkAccBalance(config).catch((e) => e);
    expect(error.codes).toEqual([]);
  });

  it('reads the live balance shape (lowercase mid, t1 balance)', async () => {
    reply(
      200,
      '{"isSuccess":true,"successCode":200,"errorCode":null,"errorMessage":"","errorList":null,"data":{"mid":"polycards","currCode":"SGD","currentBalanceAmount":0.00,"availableBalanceAmount":0.00,"t1BalanceAmount":0.00}}',
    );
    await expect(checkAccBalance(config)).resolves.toMatchObject({
      mid: 'polycards',
      currCode: 'SGD',
      availableBalanceAmount: 0,
    });
  });
});
