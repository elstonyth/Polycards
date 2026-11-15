import type { PnlPair } from '../../lib/admin-rest';
import { rm } from '../../lib/format';
import { delta } from '../economy/signs';

/** Integer sen as 'RM 1,234.00'. */
export const sen = (n: number) => rm(n / 100);

/** Current minus previous, signed; '—' when there is no previous window. */
export const vs = (p: PnlPair) =>
  p.previous_sen === null ? '—' : delta((p.current_sen - p.previous_sen) / 100);
