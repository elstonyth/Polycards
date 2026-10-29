import type { MedusaContainer } from '@medusajs/framework/types';
import { ASSISTANT_MODULE } from '../../../../modules/assistant';
import { PACKS_MODULE } from '../../../../modules/packs';
import { AGENT_TOOLS, assetBytes, isOwnAsset } from '../agent-tools';

const fetchBytes = jest.fn(async () => Buffer.from('img'));
jest.mock('../../../utils/image-fetch', () => ({
  ...jest.requireActual('../../../utils/image-fetch'),
  fetchBytes: (...a: unknown[]) => fetchBytes(...(a as [])),
}));

const CDN = 'https://polycards-media.sgp1.cdn.digitaloceanspaces.com';
const held = new Set<string>();
const created: Record<string, unknown>[] = [];
const container = {
  resolve: (k: string) =>
    ({
      [PACKS_MODULE]: {
        listPacks: async (f: { $or: { image?: string }[] }) =>
          held.has(String(f.$or[0].image)) ? [{ slug: 'p' }] : [],
        listCards: async (f: { $or: { image?: string }[] }) =>
          held.has(String(f.$or[0].image)) ? [{ handle: 'c' }] : [],
      },
      [ASSISTANT_MODULE]: {
        createAssistantMemories: async (v: Record<string, unknown>) => {
          created.push(v);
          return { id: 'aimem_1', ...v };
        },
      },
    })[k],
} as unknown as MedusaContainer;

beforeEach(() => {
  process.env.S3_FILE_URL = CDN;
  held.clear();
  created.length = 0;
  fetchBytes.mockClear();
});
afterAll(() => {
  delete process.env.S3_FILE_URL;
});

describe('assistant asset fetches', () => {
  it('takes our CDN, our sites and storefront paths', async () => {
    for (const url of [
      `${CDN}/assistant/poster.png`,
      'https://polycards.gg/images/polycards/151.webp',
      '/images/polycards/151.webp',
    ]) {
      expect([url, await isOwnAsset(url, container)]).toEqual([url, true]);
    }
  });

  it('takes an outside image only when a pack or card already holds it', async () => {
    const url = 'https://images.pricecharting.com/mew.jpg';
    expect(await isOwnAsset(url, container)).toBe(false);
    held.add(url);
    expect(await isOwnAsset(url, container)).toBe(true);
  });

  it('refuses any other host before fetching, so nothing read can leave in a URL', async () => {
    await expect(
      assetBytes('https://evil.example/x.png?d=customer-phone', container),
    ).rejects.toThrow('Not one of our images');
    await expect(assetBytes('//evil.example/x.png', container)).rejects.toThrow(
      'Not one of our images',
    );
    expect(fetchBytes).not.toHaveBeenCalled();
    await assetBytes(`${CDN}/a.png`, container);
    expect(fetchBytes).toHaveBeenCalledTimes(1);
  });
});

describe('remember', () => {
  const remember = AGENT_TOOLS.find((t) => t.name === 'remember')!;
  const admin = { userId: 'user_1', superAdmin: true };

  it('saves a note for everyone only before any tool output is in the turn', async () => {
    await expect(
      remember.run(
        { note: 'Captions end with polycards.gg.', shared: true },
        { container, access: admin, readOutside: true },
      ),
    ).rejects.toThrow('first step');
    expect(created).toEqual([]);
    await remember.run(
      { note: 'Captions end with polycards.gg.', shared: true },
      { container, access: admin, readOutside: false },
    );
    expect(created).toEqual([
      expect.objectContaining({ scope: 'shared', user_id: 'user_1' }),
    ]);
  });

  it('still saves a personal note after reading', async () => {
    await remember.run(
      { note: 'I like short captions.' },
      { container, access: admin, readOutside: true },
    );
    expect(created).toEqual([expect.objectContaining({ scope: 'user' })]);
  });
});
