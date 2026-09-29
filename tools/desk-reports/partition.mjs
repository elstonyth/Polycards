// The partition invariant (spec "Partition invariant"): for one window, the
// economy totals of group=default plus every named group must equal group=all.
// Pure, so it is tested without a backend: live-check.mjs fetches the totals
// and prints what this returns.
//
// `all` is the totals object for group=all; `parts` is [name, totals] pairs,
// default first, then each named group. Totals are compared in whole cents,
// as the backend sums them.
//
// A pass has to mean something. Empty totals and an empty window (every total
// 0, so 0 === 0 for each field) are failures, and activity in fewer than two
// parts is a warning: with one active part the check reduces to "that part =
// all" and never exercises named-group scoping.
const cents = (x) => Math.round(x * 100);
const carriesActivity = (totals) =>
  Object.values(totals ?? {}).some((v) => cents(v) !== 0);

export function checkPartition(all, parts) {
  const fields = Object.keys(all ?? {});
  const lines = parts.map(
    ([name, totals]) => `${name}: revenue ${totals?.revenue}`,
  );
  const active = parts.filter(([, totals]) => carriesActivity(totals)).length;
  const warnings =
    active < 2
      ? [
          `only ${active} part(s) carry activity, so named-group scoping was not exercised`,
        ]
      : [];
  if (fields.length === 0) {
    return {
      ok: false,
      lines: [...lines, 'FAIL no totals to compare'],
      warnings,
    };
  }
  if (fields.every((field) => cents(all[field]) === 0)) {
    return {
      ok: false,
      lines: [
        ...lines,
        'FAIL the window has no activity, so nothing was checked; pick a window with activity, e.g. last_7_days',
      ],
      warnings,
    };
  }
  let ok = true;
  for (const field of fields) {
    const sum = parts.reduce((s, [, totals]) => s + cents(totals?.[field]), 0);
    const match = sum === cents(all[field]);
    ok &&= match;
    lines.push(
      `${match ? 'ok  ' : 'FAIL'} ${field}: all ${all[field]}, default + groups ${sum / 100}`,
    );
  }
  return { ok, lines, warnings };
}
