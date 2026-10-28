import {
  desktopRandom,
  stableHumanizedInt,
} from './automation-humanized-random';

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
  scheduleShiftMinutes?: number;
  regionChoice?: 'mysg' | 'global';
  burstRemaining?: number;
  fatigue?: number;
  timerKind?: 'DRAW' | 'OFFLINE_END' | 'SESSION_BREAK_END' | 'SHORT_BREAK_END';
  waitReason?: string;
  behaviorState?: string;
  dayType?: string;
};

export type HumanizedAssignment = Pick<
  HumanizedState,
  | 'profileId'
  | 'persona'
  | 'region'
  | 'label'
  | 'regionChoice'
  | 'scheduleShiftMinutes'
>;

export function rememberHumanizedAssignments(
  previous: HumanizedAssignment[],
  states: HumanizedAssignment[],
): HumanizedAssignment[] {
  return [
    ...new Map(
      [...previous, ...states].map(
        ({
          profileId,
          persona,
          region,
          label,
          regionChoice,
          scheduleShiftMinutes,
        }) => [
          profileId,
          {
            profileId,
            persona,
            region,
            label,
            regionChoice,
            scheduleShiftMinutes,
          },
        ],
      ),
    ).values(),
  ];
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const dayMs = 86_400_000;
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
    if (remaining <= 0) return key;
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

const dayWeights: Record<Persona, readonly number[]> = {
  heavy: [0.03, 0.17, 0.5, 0.3],
  active: [0.07, 0.23, 0.5, 0.2],
  normal: [0.15, 0.3, 0.42, 0.13],
  casual: [0.3, 0.35, 0.28, 0.07],
  rare: [0.6, 0.25, 0.12, 0.03],
};
const probabilities: Record<
  Persona,
  readonly [number, number, number, number]
> = {
  heavy: [0.14, 0.12, 0.08, 0.05],
  active: [0.11, 0.16, 0.1, 0.07],
  normal: [0.08, 0.22, 0.12, 0.1],
  casual: [0.05, 0.28, 0.16, 0.16],
  rare: [0.025, 0.32, 0.18, 0.24],
};
const mod = (n: number, by = 1440) => ((n % by) + by) % by;
const stableMod = (key: string, by: number) =>
  Number(stableHumanizedInt(key) % BigInt(by));
const inWindow = (minute: number, start: number, end: number) => {
  minute = mod(minute);
  start = mod(start);
  end = mod(end);
  return start < end
    ? minute >= start && minute < end
    : start !== end && (minute >= start || minute < end);
};

function stableTraits(state: HumanizedState): string[] {
  const pool = [
    'Night Owl',
    'Routine',
    'Patient',
    'Impulsive',
    'Weekend Active',
    'Busy Worker',
    'Long Session',
    'Low Frequency',
  ];
  const count = stableMod(`traits-count:${state.profileId}`, 5) === 0 ? 3 : 2;
  const chosen = pool
    .sort((a, b) => {
      const x = stableHumanizedInt(
        `trait:${state.profileId}:${state.persona}:${a}`,
      );
      const y = stableHumanizedInt(
        `trait:${state.profileId}:${state.persona}:${b}`,
      );
      return x < y ? -1 : x > y ? 1 : 0;
    })
    .slice(0, count)
    .map((trait) =>
      state.persona === 'heavy' && trait === 'Low Frequency'
        ? 'Long Session'
        : state.persona === 'rare' && trait === 'Impulsive'
          ? 'Low Frequency'
          : trait,
    );
  return [...new Set(chosen)];
}

function scheduleShift(state: HumanizedState) {
  return (state.scheduleShiftMinutes ??=
    -75 + stableMod(`schedule-shift-v1:${state.profileId}`, 151));
}

function dailyPlan(state: HumanizedState, date: string) {
  const traits = stableTraits(state);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const weekend = weekday === 0 || weekday === 6;
  const dayRng = desktopRandom(`day-type-v2:${state.profileId}:${date}`);
  const dayType = pick(
    ['OFFLINE', 'BUSY', 'NORMAL', 'FREE'].map(
      (key, i) =>
        [
          key,
          dayWeights[state.persona][i] *
            (weekend && traits.includes('Weekend Active')
              ? key === 'OFFLINE'
                ? 0.55
                : key === 'FREE'
                  ? 1.65
                  : 1
              : 1),
        ] as const,
    ),
    dayRng.random(),
  );
  const sessions: { index: number; start: number; end: number }[] = [];
  if (dayType === 'OFFLINE') return { dayType, sessions, traits };
  const rng = desktopRandom(`daily-sessions-v2:${state.profileId}:${date}`);
  const persona = personas[state.persona];
  let count = rng.randint(...persona.count);
  if (dayType === 'BUSY')
    count = Math.max(
      state.persona === 'rare' ? 0 : 1,
      count - rng.randint(1, 2),
    );
  else if (dayType === 'FREE') count++;
  if (weekend && traits.includes('Weekend Active')) count++;
  if (traits.includes('Low Frequency')) count = Math.max(0, count - 1);
  count = Math.min(7, count);
  for (
    let attempt = 0;
    attempt < count * 3 && sessions.length < count;
    attempt++
  ) {
    const windows: [readonly [number, number], number][] =
      state.region === 'jpkr'
        ? [
            [[420, 555], 0.1],
            [[690, 855], 0.22],
            [[1050, 1430], 0.58],
            [[1380, 1500], 0.1],
          ]
        : state.region === 'euc'
          ? [
              [[420, 570], 0.1],
              [[690, 870], 0.2],
              [[1020, 1425], 0.6],
              [[1350, 1500], 0.1],
            ]
          : [
              [[450, 600], 0.08],
              [[690, 870], 0.22],
              [[1050, 1440], 0.55],
              [[1350, 1560], 0.15],
            ];
    for (const row of windows) {
      if (traits.includes('Night Owl'))
        row[1] *= row[0][0] >= 1320 ? 1.8 : 0.85;
      if (traits.includes('Busy Worker') && !weekend)
        row[1] *= row[0][0] >= 1020 ? 1.4 : 0.45;
      if (weekend && row[0][0] < 1020) row[1] *= 1.3;
    }
    const window = pick(windows, rng.random());
    const start = mod(Math.trunc(between(...window, rng.random)));
    let duration = Math.trunc(between(...persona.duration, rng.random));
    if (traits.includes('Long Session'))
      duration = Math.trunc(duration * between(1.15, 1.55, rng.random));
    if (dayType === 'BUSY')
      duration = Math.max(
        5,
        Math.trunc(duration * between(0.5, 0.78, rng.random)),
      );
    else if (dayType === 'FREE')
      duration = Math.trunc(duration * between(1.05, 1.35, rng.random));
    const end = mod(start + Math.min(duration, 180));
    const shift = scheduleShift(state);
    const [sleepStart, sleepEnd] = regions[state.region].sleep;
    if (
      inWindow(start - shift, sleepStart, sleepEnd) ||
      inWindow(
        start + Math.floor(Math.min(duration, 180) / 2) - shift,
        sleepStart,
        sleepEnd,
      )
    )
      continue;
    if (
      sessions.some(
        (s) => Math.min(mod(start - s.start), mod(s.start - start)) < 45,
      )
    )
      continue;
    sessions.push({ index: 0, start, end });
  }
  sessions
    .sort((a, b) => a.start - b.start)
    .forEach((s, i) => {
      s.index = i;
    });
  return { dayType, sessions, traits };
}

function nextSession(state: HumanizedState, nowMs: number) {
  const local = localParts(nowMs, regions[state.region].zone);
  const today = Date.parse(`${local.date}T00:00:00Z`);
  for (let day = 0; day <= 8; day++) {
    const date = new Date(today + day * dayMs).toISOString().slice(0, 10);
    const first = dailyPlan(state, date).sessions.find(
      (s) =>
        day > 0 ||
        (s.start > local.minute && mod(s.start - local.minute) < 720),
    );
    if (first)
      return {
        delay: Math.max(
          30,
          Math.trunc(day * 86400 - local.minute * 60 + first.start * 60),
        ),
        key: `${first.index}:${first.start}-${first.end}`,
      };
  }
  return { delay: 86400, key: '' };
}

function sleepDelay(state: HumanizedState, nowMs: number): number {
  const local = localParts(nowMs, regions[state.region].zone);
  const shift =
    scheduleShift(state) -
    20 +
    stableMod(`daily-jitter-v1:${state.profileId}:${local.date}`, 41);
  const adjusted = mod(local.minute - shift);
  const [start, end] = regions[state.region].sleep;
  if (!inWindow(adjusted, start, end)) return 0;
  const lag = stableMod(`wake-lag-v1:${state.profileId}:${local.date}`, 11);
  return Math.max(60, Math.trunc(mod(end - adjusted) * 60 + lag * 60));
}

function normalDelay(
  state: HumanizedState,
  nowMs: number,
  random: () => number,
): number {
  const local = localParts(nowMs, regions[state.region].zone);
  const adjusted = mod(
    local.minute -
      scheduleShift(state) +
      20 -
      stableMod(`daily-jitter-v1:${state.profileId}:${local.date}`, 41),
  );
  const peak: readonly [number, number] =
    state.region === 'mysg'
      ? [1140, 60]
      : state.region === 'thvn'
        ? [1110, 30]
        : state.region === 'jpkr'
          ? [1080, 30]
          : [1080, 0];
  const lows: readonly (readonly [number, number])[] =
    state.region === 'mysg'
      ? [[720, 1080]]
      : state.region === 'thvn'
        ? [[630, 1050]]
        : state.region === 'jpkr'
          ? [
              [390, 540],
              [540, 720],
              [840, 1080],
            ]
          : [
              [540, 720],
              [840, 1080],
            ];
  const multiplier = inWindow(adjusted, ...peak)
    ? 0.75
    : lows.some((w) => inWindow(adjusted, ...w))
      ? 1.45
      : 1;
  const bucket = pick(
    personas[state.persona].waits.map((b) => [b, b[0]] as const),
    between(0, 1, random),
  );
  return Math.max(
    30,
    Math.trunc(
      between(bucket[1] * 60, bucket[2] * 60, random) *
        multiplier *
        between(0.92, 1.08, random),
    ),
  );
}

function exactAssignments<T extends string>(
  ids: string[],
  weights: readonly (readonly [T, number])[],
  salt: string,
): Map<string, T> {
  const sorted = [...new Set(ids)].sort((a, b) => {
    const x = stableHumanizedInt(`${salt}:${a}`),
      y = stableHumanizedInt(`${salt}:${b}`);
    return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
  });
  const total = weights.reduce((sum, r) => sum + r[1], 0);
  const counts = weights.map(([key, w]) => ({
    key,
    raw: (sorted.length * w) / total,
    count: Math.floor((sorted.length * w) / total),
  }));
  const remainder = sorted.length - counts.reduce((sum, r) => sum + r.count, 0);
  [...counts]
    .sort(
      (a, b) => b.raw - b.count - (a.raw - a.count) || (a.key < b.key ? -1 : 1),
    )
    .slice(0, remainder)
    .forEach((r) => r.count++);
  const result = new Map<string, T>();
  let pos = 0;
  for (const row of counts)
    for (let i = 0; i < row.count; i++) result.set(sorted[pos++], row.key);
  return result;
}

export function createHumanizedStates(
  ids: string[],
  region: 'mysg' | 'global',
  previous: HumanizedAssignment[] = [],
): HumanizedState[] {
  if (
    !ids.length ||
    ids.some((id) => !id) ||
    !['mysg', 'global'].includes(region)
  )
    throw new Error('Invalid humanized profiles');
  const personaAssignments = exactAssignments<Persona>(
    ids,
    [
      ['heavy', 15],
      ['active', 30],
      ['normal', 35],
      ['casual', 15],
      ['rare', 5],
    ],
    'persona-v1',
  );
  const regionAssignments = exactAssignments<Region>(
    ids,
    region === 'mysg'
      ? [['mysg', 100]]
      : [
          ['mysg', 20],
          ['thvn', 15],
          ['jpkr', 15],
          ['euc', 15],
          ['uk', 10],
          ['use', 15],
          ['usw', 10],
        ],
    `region-v1:${region === 'mysg' ? 'mysg_only' : 'mixed'}`,
  );
  return ids.map((profileId) => {
    const saved = previous.find((s) => s.profileId === profileId);
    const persona = saved?.persona ?? personaAssignments.get(profileId)!;
    const assignedRegion =
      saved &&
      (saved.regionChoice ?? (saved.region === 'mysg' ? 'mysg' : 'global')) ===
        region
        ? saved.region
        : regionAssignments.get(profileId)!;
    return {
      profileId,
      persona,
      region: assignedRegion,
      regionChoice: region,
      label: `${persona[0].toUpperCase()}${persona.slice(1)} · ${regions[assignedRegion].name}`,
      scheduleShiftMinutes:
        saved?.scheduleShiftMinutes ??
        -75 + stableMod(`schedule-shift-v1:${profileId}`, 151),
      sessionKey: null,
      sessionDraws: 0,
      nextDrawAt: null,
      burstRemaining: 0,
      fatigue: 0,
    };
  });
}

export function createHumanizedState(
  profileId: string,
  region: 'mysg' | 'global',
): HumanizedState {
  return createHumanizedStates([profileId], region)[0];
}

type Decision = {
  delay: number;
  timerKind: NonNullable<HumanizedState['timerKind']>;
  behaviorState: string;
  reason: string;
  dayType: string;
  sessionKey?: string;
  resetSession?: boolean;
  burstRemaining?: number;
  fatigue?: number;
};

function decide(
  state: HumanizedState,
  nowMs: number,
  random: () => number,
  afterCycle = false,
  result = { spend: 0, value: 0 },
): Decision {
  const local = localParts(nowMs, regions[state.region].zone);
  const plan = dailyPlan(state, local.date);
  const asleep = sleepDelay(state, nowMs);
  if (asleep)
    return {
      delay: asleep,
      timerKind: 'OFFLINE_END',
      behaviorState: 'SLEEPING',
      reason: `Sleeping in ${regions[state.region].name}`,
      dayType: plan.dayType,
      fatigue: Math.max(0, (state.fatigue ?? 0) * 0.25),
    };
  const current = plan.sessions.find((s) =>
    inWindow(local.minute, s.start, s.end),
  );
  if (!current) {
    const next = nextSession(state, nowMs);
    return {
      delay: next.delay,
      timerKind: 'SESSION_BREAK_END',
      behaviorState: 'SESSION BREAK',
      reason:
        plan.dayType === 'OFFLINE'
          ? 'Offline day — next planned activity'
          : 'Between activity sessions',
      dayType: plan.dayType,
      resetSession: true,
      sessionKey: next.key,
      fatigue: Math.max(0, (state.fatigue ?? 0) * 0.45),
    };
  }
  const key = `${local.date}:${current.index}:${current.start}-${current.end}`;
  const remaining = mod(current.end - local.minute) * 60;
  const base = { dayType: plan.dayType, sessionKey: key };
  const draw = (
    delay: number,
    behaviorState: string,
    reason: string,
  ): Decision => ({ ...base, delay, timerKind: 'DRAW', behaviorState, reason });
  if (state.sessionKey !== key)
    return {
      ...draw(
        Math.min(
          Math.max(
            20,
            Math.trunc(between(...personas[state.persona].warmup, random)),
          ),
          Math.max(20, Math.trunc(remaining - 30)),
        ),
        'THINKING',
        'Session warm-up before first draw',
      ),
      resetSession: true,
      burstRemaining: 0,
      fatigue: 0,
    };
  if (!afterCycle)
    return draw(
      Math.min(
        normalDelay(state, nowMs, random),
        Math.max(20, Math.trunc(remaining - 20)),
      ),
      'NORMAL',
      'Within active session',
    );
  const fatigue = Math.min(
    1,
    Math.max(0, state.fatigue ?? 0) +
      0.08 +
      Math.min(0.2, state.sessionDraws * 0.02),
  );
  const end = (reason: string, offset = 120, floor = 0): Decision => ({
    ...base,
    delay: Math.max(floor, nextSession(state, nowMs + offset * 1000).delay),
    timerKind: 'SESSION_BREAK_END',
    behaviorState: 'SESSION BREAK',
    reason,
    burstRemaining: 0,
    fatigue,
  });
  const cap =
    personas[state.persona].cap +
    (plan.traits.includes('Long Session') ? 2 : 0) -
    (plan.traits.includes('Low Frequency') ? 1 : 0);
  if (remaining < 90 || state.sessionDraws >= Math.max(1, cap))
    return end(
      'Natural session ending / fatigue',
      Math.max(90, remaining),
      Math.trunc(remaining),
    );
  if ((state.burstRemaining ?? 0) > 0) {
    const delay = Math.trunc(between(45, 240, random));
    if (delay < remaining - 30)
      return {
        ...draw(delay, 'HIGH ENGAGEMENT', 'Short high-engagement burst'),
        burstRemaining: Math.max(0, state.burstRemaining! - 1),
        fatigue,
      };
  }
  let [burst, think, shortBreak, leave] = probabilities[state.persona];
  if (plan.traits.includes('Impulsive')) burst *= 1.55;
  if (plan.traits.includes('Patient')) think *= 1.35;
  const ratio = result.spend > 0 ? result.value / result.spend : 1;
  if (ratio >= 1.8) {
    if (between(0, 1, random) < 0.45) leave *= 2;
    else burst *= 1.6;
  } else if (ratio < 0.35) {
    think *= 1.35;
    leave *= 1.35;
  }
  leave += fatigue * 0.22;
  think += fatigue * 0.12;
  let x = between(0, 1, random);
  if (x < leave) return end('Decided to leave this session');
  x -= leave;
  if (x < shortBreak) {
    const delay = Math.trunc(between(300, 1080, random));
    return delay >= remaining - 20
      ? end('Short break became session end')
      : {
          ...base,
          delay,
          timerKind: 'SHORT_BREAK_END',
          behaviorState: 'SHORT BREAK',
          reason: 'Short interruption / break',
          fatigue,
        };
  }
  x -= shortBreak;
  if (x < burst) {
    const length = Math.floor(between(1, 5, random));
    return {
      ...draw(
        Math.trunc(between(45, 240, random)),
        'HIGH ENGAGEMENT',
        `High-engagement burst (${length + 1} draws max)`,
      ),
      burstRemaining: length,
      fatigue,
    };
  }
  x -= burst;
  if (x < think) {
    const delay = Math.trunc(between(300, 1800, random));
    return delay >= remaining - 20
      ? end('Thinking ended the session')
      : {
          ...draw(delay, 'THINKING', 'Thinking whether to draw again'),
          fatigue,
        };
  }
  const delay = normalDelay(state, nowMs, random);
  return delay >= remaining - 20
    ? end('Next normal draw falls outside this session')
    : { ...draw(delay, 'NORMAL', 'Continue within active session'), fatigue };
}

function applyDecision(
  state: HumanizedState,
  nowMs: number,
  decision: Decision,
) {
  if (
    decision.resetSession ||
    (decision.sessionKey && decision.sessionKey !== state.sessionKey)
  ) {
    state.sessionDraws = 0;
    state.fatigue = 0;
  }
  if (decision.sessionKey) state.sessionKey = decision.sessionKey;
  if (decision.burstRemaining !== undefined)
    state.burstRemaining = decision.burstRemaining;
  if (decision.fatigue !== undefined) state.fatigue = decision.fatigue;
  state.timerKind = decision.timerKind;
  state.waitReason = decision.reason;
  state.behaviorState = decision.behaviorState;
  state.dayType = decision.dayType;
  state.nextDrawAt = nowMs + Math.max(15, decision.delay) * 1000;
}

export function planHumanized(
  state: HumanizedState,
  nowMs: number,
  random: () => number = Math.random,
): { delayMs: number; reason: string; ready: boolean } {
  if (!Number.isFinite(nowMs)) throw new Error('Invalid humanized clock');
  if (state.nextDrawAt !== null && !state.timerKind) {
    state.timerKind = [
      'Thinking before first draw',
      'Persona interval',
      'Within active session',
    ].includes(state.waitReason ?? '')
      ? 'DRAW'
      : 'SESSION_BREAK_END';
    if (state.timerKind !== 'DRAW') state.nextDrawAt = null;
  }
  // Preserve persisted draw timers across deploys; never reroll a warm-up or interval.
  const drawDue =
    state.nextDrawAt !== null &&
    state.nextDrawAt <= nowMs &&
    (!state.timerKind || state.timerKind === 'DRAW');
  if (drawDue && !sleepDelay(state, nowMs))
    return { delayMs: 0, reason: 'Within active session', ready: true };
  if (state.nextDrawAt === null || state.nextDrawAt <= nowMs)
    applyDecision(state, nowMs, decide(state, nowMs, random));
  return {
    delayMs: Math.max(1, Math.ceil(state.nextDrawAt! - nowMs)),
    reason:
      state.waitReason ??
      (state.sessionDraws ? 'Persona interval' : 'Thinking before first draw'),
    ready: false,
  };
}

export function recordHumanizedCycle(
  state: HumanizedState,
  nowMs: number,
  random: () => number = Math.random,
  result = { spend: 0, value: 0 },
): number {
  if (!Number.isFinite(nowMs)) throw new Error('Invalid humanized clock');
  state.sessionDraws++;
  applyDecision(state, nowMs, decide(state, nowMs, random, true, result));
  return state.nextDrawAt! - nowMs;
}
