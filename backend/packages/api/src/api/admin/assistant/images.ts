import type { MedusaContainer } from '@medusajs/framework/types';
import { uploadFilesWorkflow } from '@medusajs/medusa/core-flows';
import sharp from 'sharp';
import { MAX_DECODE_PIXELS } from '../../utils/image-fetch';
import { POSTER_W } from '../../../modules/packs/brand-poster';
import { fitToFeed } from '../../../modules/packs/feed-size';
import { BRAND_LOGO_B64 } from '../../../modules/packs/pull-card-assets';
import { openRouterUrl } from './openrouter';

// AI images for the assistant (spec 2026-10-29): drawn by an OpenRouter image
// model, then fitted to the 1080x1350 feed size with the official logo placed
// unchanged — what the Growth desk's Hermes hook (stamp-logo.py) did, so a
// generated image is ready to post like every desk poster.

export class ImageRefused extends Error {
  constructor(
    message: string,
    /** What the refused call was still billed, USD. */
    readonly cost = 0,
  ) {
    super(message);
  }
}

type DrawOpts = {
  key: string;
  model: string;
  prompt: string;
  references?: string[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

// A draw stopped, timed out or cut off may still be billed, and no figure
// comes back for it: it counts at this, above what image models charge per
// image, so stopping never draws past the daily cap.
const IMAGE_CEILING_USD = 0.2;

const costOf = (body: { usage?: { cost?: number } } | null) =>
  Math.max(0, Number(body?.usage?.cost ?? 0) || 0);

/** One image from an OpenRouter image model, as bytes, and its cost. A draw
 *  that fails other than by refusal throws with `cost` set to the ceiling. */
export async function generateImage(
  opts: DrawOpts,
): Promise<{ buffer: Buffer; cost: number }> {
  try {
    return await draw(opts);
  } catch (err) {
    if (err instanceof ImageRefused) throw err;
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
      cost: IMAGE_CEILING_USD,
    });
  }
}

async function draw(opts: DrawOpts): Promise<{ buffer: Buffer; cost: number }> {
  const answer = await (opts.fetchImpl ?? fetch)(openRouterUrl(), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.key}`,
      'content-type': 'application/json',
      'x-title': 'Polycards admin assistant',
    },
    body: JSON.stringify({
      model: opts.model,
      modalities: ['image', 'text'],
      // Gemini image models take the post's 4:5 shape; others ignore it.
      image_config: { aspect_ratio: '4:5' },
      usage: { include: true },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: opts.prompt },
            ...(opts.references ?? []).map((url) => ({
              type: 'image_url',
              image_url: { url },
            })),
          ],
        },
      ],
    }),
    signal: opts.signal,
  });
  const body = (await answer.json().catch(() => null)) as {
    error?: { message?: string };
    usage?: { cost?: number };
    choices?: {
      message?: {
        content?: string | null;
        images?: { image_url?: { url?: string } }[];
      };
    }[];
  } | null;
  if (!answer.ok) {
    throw new ImageRefused(
      body?.error?.message ?? `The image model answered ${answer.status}.`,
    );
  }
  const url = body?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  const data = url
    ? /^data:image\/[a-z+.-]+;base64,(.+)$/i.exec(url)?.[1]
    : undefined;
  if (!data) {
    const said = body?.choices?.[0]?.message?.content?.trim();
    throw new ImageRefused(
      `The image model returned no image${said ? `: ${said.slice(0, 300)}` : '.'}`,
      costOf(body),
    );
  }
  return {
    buffer: Buffer.from(data, 'base64'),
    cost: costOf(body),
  };
}

const LOGO_WIDTH = Math.round(POSTER_W * 0.3);
const LOGO_MARGIN = 56;

/** The image as a 1080x1350 JPEG, with the official wordmark bottom-centre
 *  unless `withLogo` is false. */
export async function brandImage(
  image: Buffer,
  withLogo = true,
): Promise<Buffer> {
  const fitted = await fitToFeed(image);
  // fitToFeed returns an exact-size image as it came (maybe PNG): re-encode.
  if (!withLogo) {
    return sharp(fitted, { limitInputPixels: MAX_DECODE_PIXELS })
      .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
      .toBuffer();
  }
  const logo = await sharp(Buffer.from(BRAND_LOGO_B64, 'base64'))
    .resize({ width: LOGO_WIDTH })
    .png()
    .toBuffer();
  const { height: logoH = 0 } = await sharp(logo).metadata();
  const { height = 0 } = await sharp(fitted, {
    limitInputPixels: MAX_DECODE_PIXELS,
  }).metadata();
  return sharp(fitted, { limitInputPixels: MAX_DECODE_PIXELS })
    .composite([
      {
        input: logo,
        left: Math.round((POSTER_W - LOGO_WIDTH) / 2),
        top: height - logoH - LOGO_MARGIN,
      },
    ])
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

/** Stores an image for the chat (public file storage, so the chat can show
 *  it) and gives its URL and file id (deleting the chat deletes it). */
export async function storeImage(
  container: MedusaContainer,
  image: Buffer,
  filename: string,
  mimeType = 'image/jpeg',
): Promise<{ id: string; url: string }> {
  const { result } = await uploadFilesWorkflow(container).run({
    input: {
      files: [
        {
          filename,
          mimeType,
          content: image.toString('base64'),
          access: 'public',
        },
      ],
    },
  });
  const url = result?.[0]?.url;
  if (!url) throw new Error('The image could not be stored.');
  return { id: result[0].id, url };
}
