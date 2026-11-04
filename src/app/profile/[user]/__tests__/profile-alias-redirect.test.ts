// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// An old handle kept as an alias answers with the account's CURRENT handle;
// the page must send the visitor there (keeping ?tab=), and must not redirect
// a link that differs only by case, which is how every handle link behaved
// before.

// Hoisted: vi.mock factories run before this file's own declarations.
const redirect = vi.hoisted(() =>
  vi.fn((to: string) => {
    throw new Error(`redirect ${to}`);
  }),
);
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
  redirect,
}));
let current = 'Collector2756';
vi.mock('@/lib/data/profiles', () => ({
  getPublicProfile: async () => ({
    status: 'ok',
    profile: {
      handle: current,
      name: current,
      seed: 1,
      joined_at: '2026-10-12T09:19:00.000Z',
      stats: { pulls: 0, volume: 0, by_rarity: {} },
      recent: [],
    },
  }),
}));
vi.mock('@/lib/data/avatar-frames', () => ({
  getAvatarFrames: async () => [],
}));
vi.mock('@/lib/data/leaderboard', () => ({ getLeaderboard: async () => [] }));
vi.mock('@/lib/profile-view', () => ({ toProfileView: () => ({}) }));
vi.mock('../ProfileClient', () => ({ default: () => null }));

const { default: ProfilePage } = await import('../page');

const open = (user: string, tab?: string | string[]) =>
  ProfilePage({
    params: Promise.resolve({ user }),
    searchParams: Promise.resolve(tab === undefined ? {} : { tab }),
  });

describe('profile page alias redirect', () => {
  beforeEach(() => {
    redirect.mockClear();
    current = 'Collector2756';
  });

  it('sends an old handle to the current one, keeping the tab', async () => {
    await expect(open('Collector63408743', 'activity')).rejects.toThrow(
      'redirect /profile/Collector2756?tab=activity',
    );
  });

  it('sends an old handle without a tab to the bare profile', async () => {
    await expect(open('collector63408743')).rejects.toThrow(
      'redirect /profile/Collector2756',
    );
  });

  it('does not redirect a case-only difference', async () => {
    await open('collector2756');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('survives a repeated tab key instead of throwing', async () => {
    await open('Collector2756', ['activity', 'collection']);
    expect(redirect).not.toHaveBeenCalled();
  });
});
