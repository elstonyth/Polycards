import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Container, Heading, Text } from '@medusajs/ui';
import type { ProfitReport } from '../../lib/admin-rest';
import { rm } from '../../lib/format';
import { Hint } from '../../components/Hint';

const Tile = ({
  label,
  hint,
  value,
  note,
  tone = '',
}: {
  label: string;
  hint?: string;
  value: string;
  note: ReactNode;
  tone?: string;
}) => (
  <div className="bg-ui-bg-subtle flex flex-col gap-0.5 px-6 py-4">
    <div className="flex items-center gap-1.5">
      <Text size="small" className="text-ui-fg-subtle">
        {label}
      </Text>
      {hint && <Hint text={hint} />}
    </div>
    <Heading level="h2" className={`tabular-nums ${tone}`}>
      {value}
    </Heading>
    <Text size="xsmall" className="text-ui-fg-muted">
      {note}
    </Text>
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
          value={rm(owed.wallet_cash)}
          note={t('profit.walletNote', {
            bonus: rm(owed.wallet_bonus),
            noTopup: rm(owed.wallet_no_topup),
          })}
        />
        <Tile
          label={t('profit.cards')}
          hint={t('profit.cardsHint')}
          value={rm(owed.cards.sellback)}
          note={t('profit.cardsNote', {
            count: owed.cards.count,
            delivering: owed.cards.delivering,
          })}
        />
        <Tile
          label={t('profit.ifAllCashedOut')}
          hint={t('profit.ifAllHint')}
          value={rm(owed.if_all_cashed_out)}
          tone={
            owed.if_all_cashed_out < 0
              ? 'text-ui-fg-error'
              : 'text-ui-tag-green-text'
          }
          note={t('profit.ifAllNote', {
            kept: rm(owed.all_time_kept),
            owed: rm(owed.total),
          })}
        />
      </div>
    </Container>
  );
};
