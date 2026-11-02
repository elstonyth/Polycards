const deleteRun = jest.fn();
jest.mock('@medusajs/medusa/core-flows', () => ({
  deleteFilesWorkflow: () => ({ run: deleteRun }),
  uploadFilesWorkflow: jest.fn(),
}));

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { POST } from '../route';

function call(body: unknown, metadata: Record<string, unknown> = {}) {
  const written: { metadata?: Record<string, unknown> } = {};
  const packs = {
    mutateCustomerMetadata: jest.fn(
      async (input: {
        mutate: (m: Record<string, unknown>) => Record<string, unknown>;
      }) => {
        written.metadata = input.mutate(metadata);
      },
    ),
  };
  const json = jest.fn();
  const run = POST(
    {
      auth_context: { actor_id: 'cus_1' },
      body,
      scope: { resolve: () => packs },
    } as unknown as AuthenticatedMedusaRequest,
    { json } as unknown as MedusaResponse,
  );
  return { run, written, json };
}

beforeEach(() => deleteRun.mockReset().mockResolvedValue(undefined));

describe('POST /store/profile/avatar/preset', () => {
  it('stores the path it builds and answers with it', async () => {
    const { run, written, json } = call({ id: 12 });
    await run;
    expect(written.metadata).toEqual({
      avatar_url: '/images/avatars/avatar-12.webp',
      avatar_file_id: null,
    });
    expect(json).toHaveBeenCalledWith({
      avatar_url: '/images/avatars/avatar-12.webp',
    });
  });

  // The blob also holds saved payout accounts: a cosmetic write must carry them
  // through untouched.
  it('carries every key it does not own through untouched', async () => {
    const { run, written } = call(
      { id: 1 },
      {
        bank_accounts: [{ id: 'acc_1' }],
        equipped_frame_level: 40,
        handle: 'tan-ah-kow',
      },
    );
    await run;
    expect(written.metadata).toMatchObject({
      bank_accounts: [{ id: 'acc_1' }],
      equipped_frame_level: 40,
      handle: 'tan-ah-kow',
    });
  });

  it.each([
    0,
    81,
    1.5,
    '12',
    null,
    undefined,
    'https://evil.example/x.webp',
    '../../x',
  ])('refuses id %p and writes nothing', async (id) => {
    const { run, written } = call({ id });
    await expect(run).rejects.toThrow(/whole number/);
    expect(written.metadata).toBeUndefined();
  });

  it('accepts both ends of the catalog', async () => {
    for (const id of [1, 80]) {
      const { run, written } = call({ id });
      await run;
      expect(written.metadata?.avatar_url).toBe(
        `/images/avatars/avatar-${id}.webp`,
      );
    }
  });

  it('deletes the uploaded photo it replaced', async () => {
    const { run } = call(
      { id: 3 },
      { avatar_url: 'https://cdn/me.webp', avatar_file_id: 'file_old' },
    );
    await run;
    expect(deleteRun).toHaveBeenCalledWith({ input: { ids: ['file_old'] } });
  });

  it('deletes nothing when the current avatar was not an upload', async () => {
    const { run } = call(
      { id: 3 },
      { avatar_url: '/images/avatars/avatar-1.webp', avatar_file_id: null },
    );
    await run;
    expect(deleteRun).not.toHaveBeenCalled();
  });

  it('a failed cleanup never fails the switch', async () => {
    deleteRun.mockRejectedValue(new Error('bucket down'));
    const { run, json } = call({ id: 3 }, { avatar_file_id: 'file_old' });
    await run;
    expect(json).toHaveBeenCalled();
  });

  it('refuses a register-phase token with no actor', async () => {
    await expect(
      POST(
        { auth_context: { actor_id: '' }, body: { id: 1 } } as never,
        {} as MedusaResponse,
      ),
    ).rejects.toThrow('Unauthorized');
  });
});
