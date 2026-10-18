import { createHash } from 'node:crypto';

type Persona = 'heavy' | 'active' | 'normal' | 'casual' | 'rare';
type Region = 'mysg' | 'thvn' | 'jpkr' | 'euc' | 'uk' | 'use' | 'usw';
type Bucket = readonly [weight: number, min: number, max: number];

const personas: Record<
  Persona,
  {
    count: readonly [number, number];
    duration: readonly [number, number];
    cap: number;
    warmup: readonly [number, number];
    waits: readonly Bucket[];
  }
> = {
  heavy: {
    count: [3, 6],
    duration: [25, 120],
    cap: 9,
    warmup: [20, 180],
    waits: [
      [55, 2, 5],
      [30, 5, 8],
      [12, 8, 15],
      [3, 15, 45],
    ],
  },
  active: {
    count: [2, 5],
    duration: [20, 90],
    cap: 7,
    warmup: [30, 300],
    waits: [
      [15, 2, 4],
      [60, 4, 18],
      [20, 18, 35],
      [5, 35, 90],
    ],
  },
  normal: {
    count: [1, 4],
    duration: [15, 70],
    cap: 5,
    warmup: [45, 420],
    waits: [
      [10, 3, 8],
      [65, 8, 25],
      [20, 25, 60],
      [5, 60, 180],
    ],
  },
  casual: {
    count: [1, 3],
    duration: [10, 50],
    cap: 4,
    warmup: [60, 540],
    waits: [
      [10, 10, 20],
      [60, 20, 60],
      [25, 60, 120],
      [5, 120, 240],
    ],
  },
  rare: {
    count: [0, 2],
    duration: [5, 35],
    cap: 2,
    warmup: [90, 600],
    waits: [
      [10, 30, 60],
      [55, 60, 180],
      [30, 180, 240],
      [5, 240, 480],
    ],
  },
};

const regions: Record<
  Region,
  { name: string; zone: string; sleep: readonly [number, number] }
> = {
  mysg: {
    name: 'Malaysia / Singapore',
    zone: 'Asia/Kuala_Lumpur',
    sleep: [240, 720],
  },
  thvn: { name: 'Thailand / Vietnam', zone: 'Asia/Bangkok', sleep: [210, 630] },
  jpkr: { name: 'Japan / Korea', zone: 'Asia/Tokyo', sleep: [90, 390] },
  euc: { name: 'Central Europe', zone: 'Europe/Berlin', sleep: [60, 420] },
  uk: { name: 'United Kingdom', zone: 'Europe/London', sleep: [60, 450] },
  use: { name: 'USA — Eastern', zone: 'America/New_York', sleep: [60, 450] },
  usw: { name: 'USA — Pacific', zone: 'America/Los_Angeles', sleep: [60, 450] },
};

export type HumanizedState = {
  profileId: string;
  persona: Persona;
  region: Region;
  label: string;
  sessionKey: string | null;
  sessionDraws: number;
  nextDrawAt: number | null;
};

const formatters = new Map<string, Intl.DateTimeFormat>();
const minuteMs = 60_000;
const dayMs = 86_400_000;
const fraction = (key: string) =>
  createHash('sha256').update(key).digest().readUInt32BE(0) / 0x100000000;
const between = (min: number, max: number, random: () => number) => {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1)
    throw new Error('Invalid humanized random value');
  return min + value * (max - min);
};

function pick<T>(rows: readonly (readonly [T, number])[], value: number): T {
  let remaining = value * rows.reduce((sum, row) => sum + row[1], 0);
  for (const [key, weight] of rows) {
    remaining -= weight;
    if (remaining < 0) return key;
  }
  return rows[rows.length - 1][0];
}

function localParts(nowMs: number, zone: string) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(nowMs).map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minute:
      Number(parts.hour) * 60 +
      Number(parts.minute) +
      Number(parts.second) / 60,
  };
}

function localEpoch(date: string, minute: number, zone: string) {
  const target = Date.parse(`${date}T00:00:00Z`) + minute * minuteMs;
  let result = target;
  for (let i = 0; i < 3; i++) {
    const local = localParts(result, zone);
    result +=
      target -
      (Date.parse(`${local.date}T00:00:00Z`) + local.minute * minuteMs);
  }
  return result;
}

function sessions(state: HumanizedState, date: string) {
  let draw = 0;
  const random = () =>
    fraction(`sessions:${state.profileId}:${date}:${draw++}`);
  const persona = personas[state.persona];
  const dayType = pick(
    [
      ['offline', state.persona === 'rare' ? 30 : 8],
      ['busy', 25],
      ['normal', 50],
      ['free', 17],
    ],
    random(),
  );
  if (dayType === 'offline') return [];
  const count = Math.max(
    0,
    Math.min(
      7,
      Math.floor(between(persona.count[0], persona.count[1] + 1, random)) +
        (dayType === 'free' ? 1 : dayType === 'busy' ? -1 : 0),
    ),
  );
  const result: { start: number; end: number }[] = [];
  const [sleepStart, sleepEnd] = regions[state.region].sleep;
  for (let attempt = 0; attempt < count * 4; attempt++) {
    if (result.length === count) break;
    const window = pick<readonly [number, number]>(
      [
        [[450, 600], 8],
        [[690, 870], 22],
        [[1050, 1380], 55],
        [[1350, 1430], 15],
      ],
      random(),
    );
    const start = Math.floor(between(window[0], window[1], random));
    const duration =
      between(persona.duration[0], persona.duration[1], random) *
      (dayType === 'busy' ? 0.65 : dayType === 'free' ? 1.2 : 1);
    const end = Math.min(1440, start + Math.floor(duration));
    if (start < sleepEnd && end > sleepStart) continue;
    if (
      result.some(
        (session) => start < session.end + 15 && end + 15 > session.start,
      )
    )
      continue;
    result.push({ start, end });
  }
  return result.sort((a, b) => a.start - b.start);
}

function nextSessionDelay(
  state: HumanizedState,
  nowMs: number,
  excludedKey?: string,
) {
  const zone = regions[state.region].zone;
  const today = Date.parse(`${localParts(nowMs, zone).date}T00:00:00Z`);
  for (let day = 0; day <= 8; day++) {
    const date = new Date(today + day * dayMs).toISOString().slice(0, 10);
    for (const session of sessions(state, date)) {
      const key = `${date}:${session.start}`;
      const start = localEpoch(date, session.start, zone);
      if (start > nowMs && key !== excludedKey)
        return Math.max(30_000, start - nowMs);
    }
  }
  return dayMs;
}

export function createHumanizedState(
  profileId: string,
  region: 'mysg' | 'global',
): HumanizedState {
  if (!profileId || !['mysg', 'global'].includes(region))
    throw new Error('Invalid humanized profile');
  const persona = pick<Persona>(
    [
      ['heavy', 15],
      ['active', 30],
      ['normal', 35],
      ['casual', 15],
      ['rare', 5],
    ],
    fraction(`persona:${profileId}`),
  );
  const assignedRegion =
    region === 'mysg'
      ? 'mysg'
      : pick<Region>(
          [
            ['mysg', 20],
            ['thvn', 15],
            ['jpkr', 15],
            ['euc', 15],
            ['uk', 10],
            ['use', 15],
            ['usw', 10],
          ],
          fraction(`region:${profileId}`),
        );
  return {
    profileId,
    persona,
    region: assignedRegion,
    label: `${persona[0].toUpperCase()}${persona.slice(1)} · ${regions[assignedRegion].name}`,
    sessionKey: null,
    sessionDraws: 0,
    nextDrawAt: null,
  };
}

// shortcut: QA timing omits result-driven bursts, traits and fatigue; port them when desktop schedule parity is required.
export function planHumanized(
  state: HumanizedState,
  nowMs: number,
  random: () => number = Math.random,
): { delayMs: number; reason: string; ready: boolean } {
  if (!Number.isFinite(nowMs)) throw new Error('Invalid humanized clock');
  const region = regions[state.region];
  const local = localParts(nowMs, region.zone);
  const wait = (delayMs: number, reason: string) => ({
    delayMs: Math.max(1, Math.ceil(delayMs)),
    reason,
    ready: false,
  });
  if (local.minute >= region.sleep[0] && local.minute < region.sleep[1]) {
    return wait(
      localEpoch(local.date, region.sleep[1], region.zone) - nowMs,
      `Sleeping · ${region.name}`,
    );
  }
  const session = sessions(state, local.date).find(
    (item) => local.minute >= item.start && local.minute < item.end,
  );
  if (!session)
    return wait(nextSessionDelay(state, nowMs), 'Between activity sessions');
  const key = `${local.date}:${session.start}`;
  const remaining = localEpoch(local.date, session.end, region.zone) - nowMs;
  if (
    remaining < 60_000 ||
    (state.sessionKey === key &&
      state.sessionDraws >= personas[state.persona].cap)
  ) {
    return wait(nextSessionDelay(state, nowMs, key), 'Session break');
  }
  if (state.sessionKey !== key) {
    state.sessionKey = key;
    state.sessionDraws = 0;
    const [min, max] = personas[state.persona].warmup;
    state.nextDrawAt =
      nowMs + Math.min(between(min, max, random) * 1000, remaining - 30_000);
  }
  if (state.nextDrawAt !== null && state.nextDrawAt > nowMs)
    return wait(
      state.nextDrawAt - nowMs,
      state.sessionDraws ? 'Persona interval' : 'Thinking before first draw',
    );
  return { delayMs: 0, reason: 'Within active session', ready: true };
}

export function recordHumanizedCycle(
  state: HumanizedState,
  nowMs: number,
  random: () => number = Math.random,
): number {
  state.sessionDraws++;
  const buckets = personas[state.persona].waits;
  const bucket = pick(
    buckets.map((item) => [item, item[0]] as const),
    between(0, 1, random),
  );
  state.nextDrawAt =
    nowMs +
    Math.max(
      30_000,
      between(bucket[1], bucket[2], random) *
        minuteMs *
        between(0.92, 1.08, random),
    );
  return planHumanized(state, nowMs, random).delayMs;
}
