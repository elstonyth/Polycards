import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PricingHealth } from '../../lib/admin-rest';

const state = vi.hoisted(() => ({
  pricing: {
    data: undefined as PricingHealth | undefined,
    isPending: false,
    isError: false,
    error: null as unknown,
    refetch: vi.fn(),
  },
  alert: vi.fn<
    (counts: Record<string, number>) => {
      soundOn: boolean;
      setSound: () => void;
    }
  >(() => ({
    soundOn: false,
    setSound: vi.fn(),
  })),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      `${key} ${JSON.stringify(values ?? {})}`,
    i18n: { language: 'en' },
  }),
}));
vi.mock('./use-attention-alert', () => ({ useAttentionAlert: state.alert }));
vi.mock('../../lib/queries', () => {
  const result = (data: unknown) => ({
    data,
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
  return {
    usePricingHealth: () => state.pricing,
    useGatewayWithdrawals: () => result({ withdrawals: [], total: 0 }),
    useDeliveryOrderCount: () => result(0),
    useReferralSettlements: () => result([]),
    useGatewayAudit: () => result({ findings: [] }),
  };
});

import { AttentionCard } from './AttentionCard';
import { PricingStatus } from '../cards/PricingStatus';

const health: PricingHealth = {
  fx: null,
  cards: {
    linked: 1,
    never_synced: 0,
    stale_48h: 0,
    missing_product: [],
    pending_confirmation: 1,
    unlinked: 0,
    issues: [
      {
        handle: 'mewtwo',
        name: 'Mewtwo',
        pc_product_id: '157',
        pc_grade: 'Ungraded',
        market_value: 875,
        last_synced_at: null,
        reason: 'pending_confirmation',
        proposed_value: 47.5,
        first_seen_at: '2026-10-16T08:00:00Z',
        message: null,
      },
    ],
  },
};
const render = () =>
  renderToStaticMarkup(
    createElement(
      StaticRouter,
      { location: '/overview' },
      createElement(AttentionCard),
    ),
  );

beforeEach(() => {
  state.pricing = {
    data: undefined,
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
  state.alert.mockClear();
});

describe('pricing in dashboard attention', () => {
  it('does not claim all clear or count zero while pricing is loading', () => {
    state.pricing.isPending = true;
    expect(render()).not.toContain('dashboard.allClear');
    expect(state.alert.mock.calls[0]?.[0]).not.toHaveProperty('pricing');
  });

  it('surfaces a failed health request instead of all clear', () => {
    state.pricing.isError = true;
    state.pricing.error = new Error('offline');
    expect(render()).toContain('dashboard.loadError');
    expect(render()).not.toContain('dashboard.allClear');
    expect(state.alert.mock.calls[0]?.[0]).not.toHaveProperty('pricing');
  });

  it('adds the price queue to alerts and links to the filtered Cards table', () => {
    state.pricing.data = health;
    const html = render();
    expect(html).toContain('/cards?pricing=attention');
    expect(html).toContain('dashboard.pricingAttention');
    expect(state.alert.mock.calls[0]?.[0]).toHaveProperty('pricing', 1);
    expect(html).not.toContain('dashboard.allClear');
  });

  it('shows all clear only after pricing returns no issues', () => {
    state.pricing.data = {
      ...health,
      cards: { ...health.cards, issues: [], pending_confirmation: 0 },
    };
    expect(render()).toContain('dashboard.allClear');
    expect(state.alert.mock.calls[0]?.[0]).toHaveProperty('pricing', 0);
  });
});

describe('card pricing status', () => {
  it('does not render a healthy status when health cannot load', () => {
    const html = renderToStaticMarkup(
      createElement(PricingStatus, {
        issue: undefined,
        loading: false,
        failed: true,
      }),
    );
    expect(html).toContain('cards.pricing.unavailable');
    expect(html).not.toContain('cards.pricing.synced');
  });

  it('shows pending values, first observation and earliest confirmation', () => {
    const html = renderToStaticMarkup(
      createElement(PricingStatus, {
        issue: health.cards.issues[0],
        loading: false,
        failed: false,
      }),
    );
    for (const key of [
      'pending_confirmation',
      'current',
      'proposed',
      'firstSeen',
      'confirmAfter',
      'lastSynced',
    ]) {
      expect(html).toContain(`cards.pricing.${key}`);
    }
    expect(html).toContain('USD 875.00');
    expect(html).toContain('USD 47.50');
    expect(html).toContain(
      new Date('2026-10-17T08:00:00Z').toLocaleString('en'),
    );
  });
});
