import { useTranslation } from 'react-i18next';
import { StatusBadge } from '@medusajs/ui';
import type { GrnStatus } from '../../lib/admin-rest';

// open = waiting for its invoice (the one state that still needs the
// operator), transferred = done, reversed / reversal = struck out.
const COLOR = {
  open: 'orange',
  transferred: 'green',
  reversed: 'grey',
  reversal: 'red',
} as const satisfies Record<GrnStatus, string>;

export const GrnStatusBadge = ({ status }: { status: GrnStatus }) => {
  const { t } = useTranslation();
  return (
    <StatusBadge color={COLOR[status]}>{t(`grn.status.${status}`)}</StatusBadge>
  );
};
