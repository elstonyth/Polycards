import type { TokenSprites } from './arena-render';

// A player's token: their picture printed on a round disc, with a soft edge and a
// little gloss from the lamp above. Canvases, so the arena never decodes an image
// mid-frame. A picture from another host marks a canvas as read-protected, which
// is fine: these are only ever drawn, never read back.

const SIZE = 160;
const LOAD_TIMEOUT_MS = 2500;

function blank(): {
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D | null;
} {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  return { canvas, g: canvas.getContext('2d') };
}

function finish(g: CanvasRenderingContext2D): void {
  const mid = SIZE / 2;
  // Edge falls away from the lamp.
  const edge = g.createRadialGradient(mid, mid, mid * 0.55, mid, mid, mid);
  edge.addColorStop(0, 'rgba(0,0,0,0)');
  edge.addColorStop(1, 'rgba(0,0,0,.42)');
  g.fillStyle = edge;
  g.fillRect(0, 0, SIZE, SIZE);
  // The lamp's reflection, top left.
  const gloss = g.createLinearGradient(0, 0, 0, SIZE * 0.55);
  gloss.addColorStop(0, 'rgba(255,255,255,.13)');
  gloss.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gloss;
  g.beginPath();
  g.ellipse(mid, SIZE * 0.2, SIZE * 0.34, SIZE * 0.15, 0, 0, Math.PI * 2);
  g.fill();
}

function clipDisc(g: CanvasRenderingContext2D): void {
  g.beginPath();
  g.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2);
  g.clip();
}

function initialToken(name: string, font: string): HTMLCanvasElement | null {
  const { canvas, g } = blank();
  if (!g) return null;
  clipDisc(g);
  g.fillStyle = '#2a2a2e';
  g.fillRect(0, 0, SIZE, SIZE);
  g.fillStyle = '#fafafa';
  g.font = `900 ${SIZE * 0.46}px ${font}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(name.charAt(0).toUpperCase() || '?', SIZE / 2, SIZE * 0.53);
  finish(g);
  return canvas;
}

function pictureToken(img: HTMLImageElement): HTMLCanvasElement | null {
  const { canvas, g } = blank();
  if (!g) return null;
  clipDisc(g);
  // Cover the disc, centred, whatever the picture's shape.
  const w = img.naturalWidth || SIZE;
  const h = img.naturalHeight || SIZE;
  const k = Math.max(SIZE / w, SIZE / h);
  g.fillStyle = '#2a2a2e';
  g.fillRect(0, 0, SIZE, SIZE);
  g.drawImage(img, (SIZE - w * k) / 2, (SIZE - h * k) / 2, w * k, h * k);
  finish(g);
  return canvas;
}

/** Tokens for these entries. Initials at once, each picture as it arrives: a slow
 *  or missing image never holds the show. */
export function loadTokenSprites(
  people: readonly { who: string; avatar: string | null }[],
  entries: readonly number[],
): TokenSprites & { stop: () => void } {
  const font =
    typeof window === 'undefined'
      ? 'system-ui'
      : `${getComputedStyle(document.documentElement).getPropertyValue('--font-nekst').trim() || 'system-ui'}, system-ui`;
  const sprites = new Map<number, HTMLCanvasElement | null>();
  let stopped = false;
  for (const entry of entries) {
    const person = people[entry];
    if (!person) continue;
    sprites.set(entry, initialToken(person.who, font));
    if (!person.avatar) continue;
    const img = new Image();
    img.decoding = 'async';
    const give = window.setTimeout(() => {
      img.src = '';
    }, LOAD_TIMEOUT_MS);
    img.onload = () => {
      window.clearTimeout(give);
      // Decoded off the main thread first: uploads can be 4096 px, and drawing one
      // undecoded would stall the battle.
      void img
        .decode()
        .catch(() => undefined)
        .then(() => {
          if (stopped) return;
          try {
            const token = pictureToken(img);
            if (token) sprites.set(entry, token);
          } catch {
            // The initial stays.
          }
        });
    };
    img.onerror = () => window.clearTimeout(give);
    img.src = person.avatar;
  }
  return {
    get: (entry) => sprites.get(entry) ?? null,
    stop() {
      stopped = true;
    },
  };
}
