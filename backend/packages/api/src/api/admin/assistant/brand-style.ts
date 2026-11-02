import sharp from 'sharp';
import { fetchBytes, MAX_DECODE_PIXELS } from '../../utils/image-fetch';
import { isOwnOrigin } from './agent-tools';
import { DEFAULT_STYLE_REFS } from './style-refs';

// The house look for AI images (owner, 2026-10-29: "it should follow the
// current design of our social media, the same design language"). Written
// from the posters Polycards posted on Instagram in October 2026 (3
// Currencies, Lossless Mode, Earn up to 2.5%, The door is open, 151 is here):
// matte black with champagne-gold light, one hero object in the middle band,
// empty dark space above and below for the brand's own type, never any text
// in the art. Settings → AI can replace this text and the reference images.
export const DEFAULT_IMAGE_STYLE = [
  'Polycards brand look (a premium trading-card collectibles brand):',
  "- Palette: deep matte black background (#0a0a0a), champagne gold light (#e2c48a, deep gold #b8925a), small touches of warm white. No other colours, unless a pack or card image is given: then match that pack's own palette.",
  '- Mood: cinematic, photoreal 3D render, soft volumetric light, gold rim light, a gentle gold glow behind the hero, faint gold dust or bokeh in the air, fine film grain. Elegant and premium, calm, never busy.',
  '- Staging: one hero object (blank gold-edged card frames or slabs, a thin glowing gold ring, a doorway or arch of gold light, a plinth, floating crystals) on a glossy black reflective floor whose reflection fades quickly. Straight-on, eye level, symmetric.',
  '- Composition for a 4:5 post: the hero sits in the middle band, between about 32% and 64% of the height. The top 30% stays near-empty dark black and the bottom 30% calm, dark and low-detail, because the headline and buttons are added there later.',
  '- Never: text, letters, numbers, logos, watermarks or UI; casino imagery (coins, chips, dice, slot machines, roulette); crypto motifs (hexagon networks, circuit lines); Pokémon, Poké Balls or cartoon characters; people, hands or faces; neon rainbow colours.',
].join('\n');

/** The image model's prompt: the scene staff asked for, in the house look,
 *  with the reference images used for style only. */
export function artPrompt(
  scene: string,
  style: string,
  refs: number,
  extra = 0,
): string {
  return [
    `Create one portrait image (4:5) for a social media post. Scene: ${scene.trim()}`,
    '',
    style.trim() || DEFAULT_IMAGE_STYLE,
    '',
    refs > 0
      ? `The first ${refs} attached image${refs > 1 ? 's are' : ' is'} Polycards' own past posts: match their style exactly (palette, lighting, materials, composition, finish) but do NOT copy their objects or layout.${
          extra > 0
            ? ` The ${extra} image${extra > 1 ? 's' : ''} after ${refs > 1 ? 'them' : 'it'} ${extra > 1 ? 'are' : 'is'} what staff attached for this request: follow ${extra > 1 ? 'them' : 'it'} for content.`
            : ''
        }`
      : '',
    'Absolutely no text, letters or numbers anywhere in the image.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The style references to send, as data URLs (the image model cannot reach
 *  a local or private file URL): the ones uploaded in Settings → AI, or the
 *  posted posters' key art. Each upload is fetched once per process and
 *  shrunk to 512 px; one that cannot be read is left out. */
const fetched = new Map<string, Promise<string | null>>();
export async function styleRefs(configured: unknown): Promise<string[]> {
  // Our own uploads only, like every other image the assistant fetches.
  const urls = Array.isArray(configured)
    ? configured.filter(
        (u): u is string => typeof u === 'string' && isOwnOrigin(u),
      )
    : [];
  if (!urls.length) return DEFAULT_STYLE_REFS.map((r) => r.url);
  const out = await Promise.all(
    urls.map((url) => {
      let got = fetched.get(url);
      if (!got) {
        got = fetchBytes(url, undefined, isOwnOrigin)
          .then(async (bytes) => {
            if (!bytes) return null;
            const jpeg = await sharp(bytes, {
              limitInputPixels: MAX_DECODE_PIXELS,
            })
              .resize({ width: 512, withoutEnlargement: true })
              .jpeg({ quality: 80 })
              .toBuffer();
            return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
          })
          .catch(() => null)
          .then((ref) => {
            // A failed fetch is retried next time, not cached until restart.
            if (!ref) fetched.delete(url);
            return ref;
          });
        fetched.set(url, got);
      }
      return got;
    }),
  );
  const ok = out.filter((u): u is string => !!u);
  return ok.length ? ok : DEFAULT_STYLE_REFS.map((r) => r.url);
}
