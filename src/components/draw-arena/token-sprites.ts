import type { TokenSprites } from './arena-render';

// A player's token: their picture printed on a round disc, with a soft edge and a
// little gloss from the lamp above. Canvases, so the arena never decodes an image
// mid-frame. A picture from another host marks a canvas as read-protected, which
// is fine: these are only ever drawn, never read back.

const SIZE = 160;

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

/**
 * Every player's own picture on their discs: their upload or their default face, the
 * same `person.avatar` every other surface shows. One token per image, since most
 * players share a default face: a 300-player gate needs about 120, not 300.
 *
 * A letter stands in only until the picture arrives, or if it fails. `ready` settles
 * once every picture has come or failed, for a show that wants to open on faces.
 */
export function loadTokenSprites(
  people: readonly { who: string; avatar: string | null }[],
): TokenSprites & { ready: Promise<void>; stop: () => void } {
  const font =
    typeof window === 'undefined'
      ? 'system-ui'
      : `${getComputedStyle(document.documentElement).getPropertyValue('--font-nekst').trim() || 'system-ui'}, system-ui`;
  const pictures = new Map<string, HTMLCanvasElement>();
  const letters = new Map<string, HTMLCanvasElement | null>();
  let stopped = false;

  const load = (src: string) =>
    new Promise<void>((settled) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        // Decoded off the main thread first, so drawing it can't stall the battle.
        void img
          .decode()
          .catch(() => undefined)
          .then(() => {
            if (stopped) return;
            try {
              const token = pictureToken(img);
              if (token) pictures.set(src, token);
            } catch {
              // The letter stays.
            }
          })
          .finally(settled);
      };
      img.onerror = () => settled();
      img.src = src;
    });

  const sources = new Set(
    people.flatMap((person) => (person.avatar ? [person.avatar] : [])),
  );
  const ready = Promise.all([...sources].map(load)).then(() => undefined);

  return {
    get(entry) {
      const person = people[entry];
      if (!person) return null;
      const picture = person.avatar ? pictures.get(person.avatar) : undefined;
      if (picture) return picture;
      const letter = person.who.charAt(0).toUpperCase() || '?';
      if (!letters.has(letter)) letters.set(letter, initialToken(letter, font));
      return letters.get(letter) ?? null;
    },
    ready,
    stop() {
      stopped = true;
    },
  };
}
