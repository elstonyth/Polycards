import { describe, it, expect, vi } from 'vitest';
import { storeShim, backend } from '@/lib/__tests__/store-shim';
import { REAL_NAME_TAKEN } from '@/lib/real-name';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/store', () => ({ store: storeShim }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: vi.fn() }));

const { saveRealName } = await import('@/lib/actions/customer');

const ROUTE = 'POST /store/customers/me/real-name';

describe('saveRealName', () => {
  it('shows the refusal for a name another account holds, word for word', async () => {
    backend({ [ROUTE]: { status: 400, body: { message: REAL_NAME_TAKEN } } });
    await expect(saveRealName({ real_name: 'Tan Ah Kow' })).resolves.toEqual({
      ok: false,
      error: REAL_NAME_TAKEN,
    });
  });

  it('says nothing about which verification service staff use', () => {
    expect(REAL_NAME_TAKEN).not.toMatch(/touch|tng|wallet/i);
  });

  it('returns the stored name when the save goes through', async () => {
    backend({ [ROUTE]: { body: { real_name: 'Tan Ah Kow' } } });
    await expect(saveRealName({ real_name: ' Tan  Ah Kow ' })).resolves.toEqual(
      {
        ok: true,
        realName: 'Tan Ah Kow',
      },
    );
  });
});
