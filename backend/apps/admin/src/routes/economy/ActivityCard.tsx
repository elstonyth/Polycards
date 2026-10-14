import { useTranslation } from 'react-i18next';
import { Container, Heading, Text } from '@medusajs/ui';
import type { ProfitReport } from '../../lib/admin-rest';
import { rm } from '../../lib/format';

// Order and direction of the lines: what came in to the house first, then
// what went back out to players.
const LINES: {
  key: keyof ProfitReport['activity'];
  out?: boolean;
}[] = [
  { key: 'pack_sales' },
  { key: 'delivery_fees' },
  { key: 'sellbacks', out: true },
  { key: 'promo_given', out: true },
  { key: 'referral_commission', out: true },
  { key: 'adjustments', out: true },
];

/** Where credit moved inside the site over the period. */
export const ActivityCard = ({ data }: { data: ProfitReport }) => {
  const { t } = useTranslation();
  return (
    <Container className="pc-settle p-0 [animation-delay:140ms]">
      <div className="px-6 py-4">
        <Heading level="h2">{t('profit.movedTitle')}</Heading>
        <Text size="small" className="text-ui-fg-subtle mt-1">
          {t('profit.movedSubtitle')}
        </Text>
      </div>
      <ul className="divide-y border-t">
        {LINES.map(({ key, out }) => {
          const v = data.activity[key];
          return (
            <li
              key={key}
              className="flex items-center justify-between gap-4 px-6 py-2.5"
            >
              <Text size="small" className="text-ui-fg-subtle">
                {t(`profit.moved.${key}`)}
              </Text>
              <Text size="small" weight="plus" className="tabular-nums">
                {/* Adjustments carry their own sign (staff can take back). */}
                {out && v > 0 ? `− ${rm(v)}` : rm(v)}
              </Text>
            </li>
          );
        })}
      </ul>
    </Container>
  );
};
