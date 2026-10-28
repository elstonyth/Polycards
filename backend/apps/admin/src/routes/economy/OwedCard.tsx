import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Container, Heading, Text } from '@medusajs/ui';
import type { ProfitReport } from '../../lib/admin-rest';
import { rm } from '../../lib/format';
import { Hint } from '../../components/Hint';
import { signed } from './signs';

const Tile = ({
  label,
  hint,
  value,
  notes,
  tone = '',
}: {
  label: string;
  hint?: string;
  value: string;
  notes: ReactNode[];
  tone?: string;
}) => (
  <div className="bg-ui-bg-subtle flex flex-col gap-0.5 px-6 py-4">
    <div className="flex items-center gap-1.5">
      <Text size="small" className="text-ui-fg-subtle">
        {label}
      </Text>
      {hint && <Hint text={hint} />}
    </div>
    <Text size="xlarge" weight="plus" className={`tabular-nums ${tone}`}>
      {value}
    </Text>
    {notes.filter(Boolean).map((n, i) => (
      <Text key={i} size="xsmall" className="text-ui-fg-subtle">
        {n}
      </Text>
    ))}
  </div>
);

/** What players could still cash out right now, and profit if they did. */
export const OwedCard = ({ data }: { data: ProfitReport }) => {
  const { t } = useTranslation();
  const { owed } = data;
  return (
    <Container className="pc-settle p-0 [animation-delay:90ms]">
      <div className="px-6 py-4">
        <div className="flex items-center gap-2">
          <Heading level="h2">{t('profit.owedTitle')}</Heading>
          <Badge size="2xsmall" color="grey">
            {t('profit.owedNow')}
          </Badge>
        </div>
        <Text size="small" className="text-ui-fg-subtle mt-1">
          {t('profit.owedSubtitle')}
        </Text>
      </div>
      <div className="bg-ui-border-base grid grid-cols-1 gap-px border-t md:grid-cols-3">
        <Tile
          label={t('profit.walletCash')}
          hint={t('profit.walletHint')}
          value={rm(
            owed.wallet_cash + owed.payouts_in_flight + owed.commission_unpaid,
          )}
          notes={[
            owed.payouts_in_flight > 0 &&
              t('profit.inFlightNote', { amount: rm(owed.payouts_in_flight) }),
            owed.commission_unpaid > 0 &&
              t('profit.commissionNote', {
                amount: rm(owed.commission_unpaid),
              }),
            t('profit.walletNote', {
              bonus: rm(owed.wallet_bonus),
              noTopup: rm(owed.wallet_no_topup),
            }),
          ]}
        />
        <Tile
          label={t('profit.cards')}
          hint={t('profit.cardsHint')}
          value={rm(owed.cards.sellback)}
          notes={[
            t('profit.cardsNote', {
              count: owed.cards.count,
              delivering: owed.cards.delivering,
            }),
            owed.cards_no_topup.count > 0 &&
              t('profit.cardsNoTopupNote', {
                count: owed.cards_no_topup.count,
                value: rm(owed.cards_no_topup.sellback),
              }),
          ]}
        />
        <Tile
          label={t('profit.ifAllCashedOut')}
          hint={t('profit.ifAllHint')}
          value={signed(owed.if_all_cashed_out)}
          tone={
            owed.if_all_cashed_out < 0
              ? 'text-ui-fg-error'
              : 'text-ui-tag-green-text'
          }
          notes={[
            t('profit.ifAllNote', {
              kept: signed(owed.all_time_kept),
              owed: rm(owed.total),
              shipped: rm(owed.shipped.value),
            }),
          ]}
        />
      </div>
    </Container>
  );
};
