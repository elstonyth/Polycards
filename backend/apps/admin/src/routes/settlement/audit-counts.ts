/**
 * The audit card's counts. `findings_total` is what the gateway disagrees
 * with; a retired gateway's rows can never be checked again, so the backend
 * counts them apart (`retired_total`) and they never hold up the "payments
 * differ" badge. Neither do findings an operator acknowledged
 * (`acknowledged_total`). All are listed. The list holds at most 100 rows.
 */
export const auditCounts = (a: {
  findings_total: number;
  retired_total?: number;
  acknowledged_total?: number;
  findings: readonly unknown[];
}) => {
  const retired = a.retired_total ?? 0;
  const acknowledged = a.acknowledged_total ?? 0;
  const all = a.findings_total + retired + acknowledged;
  return {
    show: a.findings.length > 0,
    differ: a.findings_total,
    retired,
    acknowledged,
    all,
    capped: a.findings.length < all,
  };
};
