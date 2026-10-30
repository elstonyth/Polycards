import { cn } from '@/lib/utils';

/**
 * A country flag drawn as inline SVG, for the currency picker.
 *
 * Not the regional-indicator emoji PhoneField uses: Windows has no flag glyphs
 * and shows those as the letters "MY" / "SG", and here the flag IS the signal
 * (it tells a customer which country's bank pays in that currency). Both
 * flags fill the same 3:2 box; Malaysia's 2:1 flag is cropped from the right
 * so the canton stays whole. USDT is no country: it gets Tether's mark (₮ on
 * teal) in the same box, so the picker rows still line up.
 */
export type FlagCountry = 'MY' | 'SG' | 'USDT';

/** Points of an n-pointed star, for an SVG <polygon>. */
export function starPoints(
  cx: number,
  cy: number,
  points: number,
  outer: number,
  inner: number,
): string {
  return Array.from({ length: points * 2 }, (_, i) => {
    const r = i % 2 ? inner : outer;
    const a = (Math.PI * i) / points - Math.PI / 2;
    return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
  }).join(' ');
}

// Singapore: five stars on a ring inside the crescent's opening.
const SG_STARS = Array.from({ length: 5 }, (_, k) => {
  const a = (Math.PI * 2 * k) / 5 - Math.PI / 2;
  return starPoints(
    10 + 2.05 * Math.cos(a),
    5 + 2.05 * Math.sin(a),
    5,
    0.78,
    0.3,
  );
});

// Malaysia: the 14-pointed star of the Jalur Gemilang.
const MY_STAR = starPoints(10.1, 4, 14, 2.35, 1.05);

function Flag({ country }: { country: FlagCountry }) {
  if (country === 'USDT') {
    return (
      <>
        <rect width="30" height="20" fill="#26A17B" />
        <rect x="9" y="4" width="12" height="2.6" fill="#fff" />
        <rect x="13.4" y="4" width="3.2" height="12" fill="#fff" />
        <ellipse
          cx="15"
          cy="9.4"
          rx="6.6"
          ry="1.8"
          fill="none"
          stroke="#fff"
          strokeWidth="1.1"
        />
      </>
    );
  }
  if (country === 'SG') {
    return (
      <>
        <rect width="30" height="20" fill="#fff" />
        <rect width="30" height="10" fill="#EF3340" />
        <circle cx="6.1" cy="5" r="3.6" fill="#fff" />
        <circle cx="7.25" cy="5" r="3.3" fill="#EF3340" />
        {SG_STARS.map((points) => (
          <polygon key={points} points={points} fill="#fff" />
        ))}
      </>
    );
  }
  return (
    <>
      <rect width="28" height="14" fill="#fff" />
      {[0, 2, 4, 6, 8, 10, 12].map((y) => (
        <rect key={y} y={y} width="28" height="1" fill="#CC0001" />
      ))}
      <rect width="14" height="8" fill="#010066" />
      <circle cx="5.4" cy="4" r="3" fill="#FFCC00" />
      <circle cx="6.3" cy="4" r="2.55" fill="#010066" />
      <polygon points={MY_STAR} fill="#FFCC00" />
    </>
  );
}

export function CountryFlag({
  country,
  className,
}: {
  country: FlagCountry;
  /** Size it here, at a 3:2 ratio (e.g. `h-6 w-9`). */
  className?: string;
}) {
  return (
    <svg
      viewBox={country === 'MY' ? '0 0 28 14' : '0 0 30 20'}
      preserveAspectRatio="xMinYMid slice"
      aria-hidden
      focusable="false"
      data-flag={country}
      className={cn(
        'shrink-0 overflow-hidden rounded-[3px] ring-1 ring-white/15',
        className,
      )}
    >
      <Flag country={country} />
    </svg>
  );
}
