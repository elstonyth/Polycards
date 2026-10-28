import { StatusBadge, Text } from '@medusajs/ui';
import { useTranslation } from 'react-i18next';
import type { PricingIssue } from '../../lib/admin-rest';
import { inCurrency } from '../../lib/format';

export const PricingStatus = ({
  issue,
  loading,
  failed,
}: {
  issue: PricingIssue | undefined;
  loading: boolean;
  failed: boolean;
}) => {
  const { t, i18n } = useTranslation();
  const date = (at: string) => new Date(at).toLocaleString(i18n.language);
  if (failed || loading) {
    return (
      <Text size="small" role="status">
        {t(`cards.pricing.${failed ? 'unavailable' : 'loading'}`)}
      </Text>
    );
  }
  if (!issue) {
    return <StatusBadge color="green">{t('cards.pricing.synced')}</StatusBadge>;
  }
  return (
    <div className="flex min-w-56 max-w-80 flex-col gap-1 py-2">
      <div>
        <StatusBadge
          color={
            issue.reason === 'sync_error' || issue.reason === 'missing_product'
              ? 'red'
              : 'orange'
          }
        >
          {t(`cards.pricing.${issue.reason}`)}
        </StatusBadge>
      </div>
      <Text size="xsmall" className="tabular-nums">
        {t('cards.pricing.current', {
          value: inCurrency(issue.market_value, 'USD'),
        })}
        {issue.proposed_value !== null && (
          <span className="block">
            {t('cards.pricing.proposed', {
              value: inCurrency(issue.proposed_value, 'USD'),
            })}
          </span>
        )}
      </Text>
      {issue.pc_product_id && (
        <Text size="xsmall" className="text-ui-fg-subtle">
          {t('cards.pricing.source', {
            id: issue.pc_product_id,
            grade: issue.pc_grade ?? '—',
          })}
        </Text>
      )}
      {issue.first_seen_at && (
        <Text size="xsmall" className="text-ui-fg-subtle">
          {t('cards.pricing.firstSeen', { at: date(issue.first_seen_at) })}
          <span className="block">
            {t('cards.pricing.confirmAfter', {
              at: date(
                new Date(
                  Date.parse(issue.first_seen_at) + 24 * 60 * 60 * 1000,
                ).toISOString(),
              ),
            })}
          </span>
        </Text>
      )}
      <Text size="xsmall" className="text-ui-fg-subtle">
        {t('cards.pricing.lastSynced', {
          at: issue.last_synced_at
            ? date(issue.last_synced_at)
            : t('cards.pricing.never'),
        })}
      </Text>
      {issue.message && (
        <Text size="xsmall" className="text-ui-fg-subtle break-words">
          {issue.message}
        </Text>
      )}
    </div>
  );
};
