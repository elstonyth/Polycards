import sharp, { type OverlayOptions } from 'sharp';
import { ensureBundledFonts } from '../../api/admin/media/label-font';
import { fetchBytes, MAX_DECODE_PIXELS } from '../../api/utils/image-fetch';
import { capH, CTA_H, ctaRow, icon, POSTER_H, POSTER_W } from './brand-poster';
import { rmWhole } from './challenge-results-poster';
import { sizeToFit, twoLines } from './challenge-poster';
import { BRAND_LOGO_B64 } from './pull-card-assets';
import { baseline, body, display, fit, measure, textEl } from './pull-card';

// The week's tasks as a posting poster for the Growth desk (GET
// /reports/growth/tasks-poster and the Monday 9 a.m. drop), 1080x1350: the
// check-in tiers as one strip (each day count with its prize), then a tile per
// other weekly task (the requirement, the prize and what /task says it is
// worth). Every word comes from the live /task catalogue.
//
// Text is SVG rendered by sharp against the bundled fonts, so judge the look
// from a Linux render (the prod container), never a Windows one.

type Kind = 'credit' | 'pack' | 'card';

export type CheckinTier = {
  days: number;
  /** As /task words it: 'Free rip · 30th Celebration'. */
  prize: string;
  kind: Kind;
  valueMyr: number | null;
};

export type TaskTile = {
  /** 'Rip 10 × Bronze Pack' */
  requirement: string;
  prize: string;
  kind: Kind;
  valueMyr: number | null;
};

export type TasksPosterInput = {
  /** '5 OCT – 11 OCT' */
  weekLabel: string;
  /** Fewest days first. */
  checkins: CheckinTier[];
  tasks: TaskTile[];
  siteHost: string;
};

/** The weekly tasks of the /task catalogue, split for the poster: check-in
 *  tiers by days, every other task in catalogue order with its requirement
 *  as a sentence fragment ('Rip 10 × Bronze Pack'). */
export function splitWeeklyTasks<
  T extends {
    checkin_days: number | null;
    requirement: string;
    prize: string;
    prize_type: Kind;
    value_myr: number | null;
  },
>(
  weekly: T[],
): {
  checkins: (CheckinTier & { task: T })[];
  tasks: (TaskTile & { task: T })[];
} {
  const checkins = weekly
    .filter((t) => t.checkin_days !== null)
    .map((t) => ({
      days: t.checkin_days as number,
      prize: t.prize,
      kind: t.prize_type,
      valueMyr: t.value_myr,
      task: t,
    }))
    .sort((a, b) => a.days - b.days);
  const tasks = weekly
    .filter((t) => t.checkin_days === null)
    .map((t) => ({
      requirement: t.requirement.replace(/\s+this week$/i, ''),
      prize: t.prize,
      kind: t.prize_type,
      valueMyr: t.value_myr,
      task: t,
    }));
  return { checkins, tasks };
}

/** '5 OCT – 11 OCT' for the task week starting on `weekStart` (YYYY-MM-DD,
 *  the Malaysia Monday). */
export function taskWeekLabel(weekStart: string): string {
  const start = new Date(`${weekStart}T00:00:00Z`);
  const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
  const day = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  return `${day.format(start)} – ${day.format(end)}`.toUpperCase();
}

const INK = '#0a0a0a';
const CHARCOAL = '#171717';
const GRAPHITE = '#262626';
const HAIRLINE = 'rgba(255,255,255,0.1)';
const WHITE = '#fafafa';
const SILVER = '#a3a3a3';
const SOFT = '#d4d4d4';
const CHASE = '#ffb020';

const W = POSTER_W;
const H = POSTER_H;
const PAD = 64;
const TEXT_W = W - 2 * PAD;
const LOGO_H = 50;
const LOGO_W = Math.round((LOGO_H * 360) / 97); // polycards-logo.png is 360x97
const GAP = 20;
const MIN_TILE_H = 110;

// Lucide wallet and gift, as on the ladder poster.
const ICON_WALLET =
  '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/>' +
  '<path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>';
const ICON_GIFT =
  '<rect x="3" y="7" width="18" height="4" rx="1"/><path d="M12 7v14"/>' +
  '<path d="M20 11v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8"/>' +
  '<path d="M7.5 7a1 1 0 0 1 0-5A4.8 8 0 0 1 12 7a4.8 8 0 0 1 4.5-5 1 1 0 0 1 0 5"/>';

const decode = (bytes: Buffer) =>
  sharp(bytes, { limitInputPixels: MAX_DECODE_PIXELS });

async function artBox(
  bytes: Buffer | null,
  w: number,
  h: number,
): Promise<Buffer | null> {
  if (!bytes) return null;
  try {
    return await decode(bytes)
      .resize(Math.round(w), Math.round(h), {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

/** A prize's picture box: the art, or the wallet (a credit) or a gift box
 *  (art that is missing). Returns whether the art was missing. */
async function prizeArt(
  kind: Kind,
  bytes: Buffer | null,
  x: number,
  y: number,
  w: number,
  h: number,
  layers: OverlayOptions[],
  svg: string[],
): Promise<boolean> {
  const pic = kind === 'credit' ? null : await artBox(bytes, w, h);
  if (pic) {
    layers.push({ input: pic, left: Math.round(x), top: Math.round(y) });
    return false;
  }
  const credit = kind === 'credit';
  svg.push(
    `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="16" ` +
      `fill="${credit ? 'rgba(255,176,32,0.12)' : GRAPHITE}"/>`,
    icon(
      credit ? ICON_WALLET : ICON_GIFT,
      x + w / 2 - Math.min(w, h) * 0.25,
      y + h / 2,
      Math.min(w, h) * 0.5,
      credit ? CHASE : SILVER,
    ),
  );
  return !credit;
}

/**
 * Compose the poster. `art.checkins[i]` and `art.tasks[i]` are the prize
 * pictures of the matching tier and task (null for a credit, or when it
 * could not be fetched). `placeholders` names the prizes whose picture was
 * missing, as 'checkin:<days>' and 'task:<index>'.
 */
export async function composeTasksPoster(
  input: TasksPosterInput,
  art: { checkins: (Buffer | null)[]; tasks: (Buffer | null)[] },
): Promise<{ jpeg: Buffer; placeholders: string[]; dropped: number }> {
  ensureBundledFonts(); // before the first text render in this process
  const mid = W / 2;
  const layers: OverlayOptions[] = [
    {
      input: await sharp(Buffer.from(BRAND_LOGO_B64, 'base64'))
        .resize(LOGO_W, LOGO_H)
        .toBuffer(),
      left: PAD,
      top: PAD,
    },
  ];
  const svg: string[] = [
    textEl(
      input.weekLabel,
      W - PAD,
      baseline(PAD + LOGO_H / 2, 28),
      body(28, 3),
      SILVER,
      'end',
    ),
  ];
  const placeholders: string[] = [];

  // ---- title and the gold line ---------------------------------------------
  const title = 'TASKS OF THE WEEK';
  const titleSize = await sizeToFit([title], (s) => display(s), 92, 48, TEXT_W);
  let y = PAD + LOGO_H + 56 + titleSize / 2;
  svg.push(
    textEl(
      title,
      mid,
      baseline(y, titleSize),
      display(titleSize),
      WHITE,
      'middle',
    ),
  );
  y += titleSize / 2 + 40;
  const gold = 'COMPLETE TASKS · CLAIM REAL REWARDS';
  const goldSize = await sizeToFit([gold], (s) => display(s), 40, 24, TEXT_W);
  svg.push(
    textEl(
      gold,
      mid,
      baseline(y, goldSize),
      display(goldSize),
      CHASE,
      'middle',
    ),
  );
  y += goldSize / 2 + 40;

  const ctaTop = H - PAD - CTA_H;
  const bottom = ctaTop - 40;

  // ---- the check-in strip ------------------------------------------------------
  if (input.checkins.length) {
    const n = input.checkins.length;
    const panelY = Math.round(y);
    const colW = (TEXT_W - 48) / n;
    const artW = Math.min(150, colW - 24);
    const artH = Math.round(artW * 1.25);
    const panelH = 64 + 44 + artH + 16 + 60 + 44 + 20;
    svg.push(
      `<rect x="${PAD + 1}" y="${panelY + 1}" width="${TEXT_W - 2}" height="${panelH - 2}" rx="32" ` +
        `fill="${CHARCOAL}" stroke="${HAIRLINE}" stroke-width="2"/>`,
      textEl(
        'DAILY CHECK-IN',
        mid,
        baseline(panelY + 44, 24),
        body(24, 4),
        SILVER,
        'middle',
      ),
    );
    for (const [i, tier] of input.checkins.entries()) {
      const cx = PAD + 24 + colW * i + colW / 2;
      const top = panelY + 64;
      const label = `${tier.days} DAY${tier.days === 1 ? '' : 'S'}`;
      svg.push(
        textEl(label, cx, baseline(top + 18, 30), display(30), WHITE, 'middle'),
      );
      const ay = top + 44;
      if (
        await prizeArt(
          tier.kind,
          art.checkins[i] ?? null,
          cx - artW / 2,
          ay,
          artW,
          artH,
          layers,
          svg,
        )
      ) {
        placeholders.push(`checkin:${tier.days}`);
      }
      let ny = ay + artH + 16 + capH(20) / 2;
      for (const line of await twoLines(tier.prize, body(20), colW - 12)) {
        svg.push(textEl(line, cx, baseline(ny, 20), body(20), SOFT, 'middle'));
        ny += 26;
      }
      if (tier.valueMyr !== null && tier.valueMyr > 0) {
        svg.push(
          textEl(
            rmWhole(tier.valueMyr),
            cx,
            baseline(ay + artH + 16 + 60 + 22, 30),
            display(30),
            CHASE,
            'middle',
          ),
        );
      }
    }
    y = panelY + panelH + GAP;
  }

  // ---- one tile per other task ------------------------------------------------
  // As many tiles as fit at the smallest readable height; the rest are
  // reported back as dropped, never drawn over the pill.
  const fits = Math.max(0, Math.floor((bottom - y + 16) / (MIN_TILE_H + 16)));
  const shown = input.tasks.slice(0, fits);
  const dropped = input.tasks.length - shown.length;
  if (shown.length) {
    const n = shown.length;
    const th = Math.max(
      MIN_TILE_H,
      Math.min(200, Math.floor((bottom - y - (n - 1) * 16) / n)),
    );
    const top = Math.round(
      y + Math.max(0, (bottom - y - (n * th + (n - 1) * 16)) / 2),
    );
    for (const [i, task] of shown.entries()) {
      const ty = top + i * (th + 16);
      svg.push(
        `<rect x="${PAD + 1}" y="${ty + 1}" width="${TEXT_W - 2}" height="${th - 2}" rx="24" ` +
          `fill="${CHARCOAL}" stroke="${HAIRLINE}" stroke-width="2"/>`,
      );
      const ah = th - 24;
      const aw = Math.round(ah * 0.8);
      const ax = PAD + 16;
      if (
        await prizeArt(
          task.kind,
          art.tasks[i] ?? null,
          ax,
          ty + 12,
          aw,
          ah,
          layers,
          svg,
        )
      ) {
        placeholders.push(`task:${i}`);
      }
      const right = W - PAD - 36;
      const worth = task.valueMyr !== null && task.valueMyr > 0;
      const value = worth ? rmWhole(task.valueMyr as number) : '';
      const valueFont = display(44, -1);
      const valueW = worth ? await measure(value, valueFont) : 0;
      const textX = ax + aw + 32;
      const textW = right - (valueW ? valueW + 40 : 0) - textX;
      const reqFont = body(34);
      const req = await fit(task.requirement, reqFont, textW);
      const prize = await fit(task.prize, body(24), textW);
      const blockH = capH(34) + 18 + capH(24);
      const by = ty + (th - blockH) / 2;
      svg.push(
        textEl(req, textX, baseline(by + capH(34) / 2, 34), reqFont, WHITE),
        textEl(
          prize,
          textX,
          baseline(by + capH(34) + 18 + capH(24) / 2, 24),
          body(24),
          SOFT,
        ),
      );
      if (worth) {
        const pairTop = ty + (th - (capH(20) + 16 + capH(44))) / 2;
        svg.push(
          textEl(
            'WORTH',
            right,
            baseline(pairTop + capH(20) / 2, 20),
            body(20, 4),
            SILVER,
            'end',
          ),
          textEl(
            value,
            right,
            baseline(pairTop + capH(20) + 16 + capH(44) / 2, 44),
            valueFont,
            CHASE,
            'end',
          ),
        );
      }
    }
  }

  svg.push(await ctaRow(mid, ctaTop, input.siteHost));

  const base = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<defs><radialGradient id="wash" cx="0.5" cy="0.5" r="0.5">` +
      `<stop offset="0" stop-color="#ffffff" stop-opacity="0.05"/>` +
      `<stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient></defs>` +
      `<rect width="${W}" height="${H}" fill="${INK}"/>` +
      `<ellipse cx="${mid}" cy="${Math.round(H / 2)}" rx="${Math.round(W * 0.6)}" ry="${Math.round(H * 0.4)}" fill="url(#wash)"/>` +
      `${svg.join('')}</svg>`,
  );
  const jpeg = await sharp(base)
    .composite(layers)
    .flatten({ background: INK })
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
    .toBuffer();
  return { jpeg, placeholders, dropped };
}

/** Fetch each prize's picture, then compose. */
export async function renderTasksPoster(
  input: TasksPosterInput,
  urls: { checkins: (string | null)[]; tasks: (string | null)[] },
): Promise<{ jpeg: Buffer; missing: string[]; dropped: number }> {
  const get = (url: string | null) =>
    url ? fetchBytes(url).catch(() => null) : Promise.resolve(null);
  const [checkins, tasks] = await Promise.all([
    Promise.all(urls.checkins.map(get)),
    Promise.all(urls.tasks.map(get)),
  ]);
  const { jpeg, placeholders, dropped } = await composeTasksPoster(input, {
    checkins,
    tasks,
  });
  return { jpeg, missing: placeholders, dropped };
}
