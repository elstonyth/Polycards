import { useTranslation } from 'react-i18next';
import { Container, Heading, Text } from '@medusajs/ui';
import type { ProfitReport } from '../../lib/admin-rest';
import { Hint } from '../../components/Hint';
import { flowLine } from './signs';

// Order and direction of the lines: what came in to the house first, then
// what went back out to players.
const LINES: {
  key: keyof ProfitReport['activity'];
  out?: boolean;
  hint?: boolean;
}[] = [
  { key: 'pack_sales' },
  { key: 'delivery_fees' },
  { key: 'sellbacks', out: true, hint: true },
  { key: 'promo_given', out: true, hint: true },
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
        {LINES.map(({ key, out, hint }) => (
          <li
            key={key}
            className="flex items-center justify-between gap-4 px-6 py-2.5"
          >
            <div className="flex items-center gap-1.5">
              <Text size="small" className="text-ui-fg-subtle">
                {t(`profit.moved.${key}`)}
              </Text>
              {hint && <Hint text={t(`profit.movedHint.${key}`)} />}
            </div>
            <Text size="small" weight="plus" className="tabular-nums">
              {flowLine(data.activity[key], !!out)}
            </Text>
          </li>
        ))}
      </ul>
    </Container>
  );
};
