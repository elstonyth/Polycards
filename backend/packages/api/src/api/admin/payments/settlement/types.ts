// The JSON body of GET /admin/payments/settlement, written once (ADR 0017):
// the handler is checked against it and the admin imports it as
// `@acme/api/admin/payments/settlement`. Types only. Amounts are RM.
import type { CustomerScope } from '../../../../modules/packs/real-customers';
import type {
  SettlementDirection,
  SettlementPeriod,
} from '../../../../modules/packs/gateway-settlement';

export type SettlementGranularity = 'week' | 'month';

export type SettlementReport = {
  granularity: SettlementGranularity;
  /** The rail the report is scoped to; null = every gateway. Amounts are RM
   *  either way (a regional payment at the rate it locked). */
  currency: string | null;
  scope: CustomerScope;
  periods_requested: number;
  /** ISO instant the first period starts. */
  since: string;
  periods: SettlementPeriod[];
};

export type { SettlementDirection, SettlementPeriod };
