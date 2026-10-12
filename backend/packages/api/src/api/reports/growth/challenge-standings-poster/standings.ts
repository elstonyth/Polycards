import {
  resultsHeadline,
  rmWhole,
} from '../../../../modules/packs/challenge-results-poster';

/** The gold line for the running week: the pool and how much more unlocks
 *  the next stage, or how many stages the pool has unlocked once it has them
 *  all. Unlocking is pool >= threshold, as settlement counts it. */
export function standingsHeadline(
  poolMyr: number,
  stages: { stageNumber: number; thresholdMyr: number }[],
): string {
  const next = stages.find((s) => poolMyr < s.thresholdMyr);
  if (!next) {
    return resultsHeadline(
      poolMyr,
      stages.map((s) => s.stageNumber),
    );
  }
  // The amount last: in Nekst a "0" runs into a following "TO".
  return `${rmWhole(poolMyr)} POOLED · STAGE ${next.stageNumber} NEEDS ${rmWhole(Math.ceil(next.thresholdMyr - poolMyr))}`;
}

/** 'SUN 11 OCT': the week's last day in its own timezone (its end is the
 *  exclusive reset, so the moment before it). */
export function weekEndsLabel(endUtc: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone,
  })
    .format(new Date(endUtc.getTime() - 1))
    .replace(/,/g, '')
    .toUpperCase();
}
