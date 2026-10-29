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

/** One image from an OpenRouter image model, as bytes, and its cost. */
export async function generateImage(opts: {
  key: string;
  model: string;
  prompt: string;
  references?: string[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{ buffer: Buffer; cost: number }> {
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
      Number(body?.usage?.cost ?? 0),
    );
  }
  return {
    buffer: Buffer.from(data, 'base64'),
    cost: Number(body?.usage?.cost ?? 0),
  };
}

const LOGO_WIDTH = Math.round(POSTER_W * 0.3);
const LOGO_MARGIN = 56;

/** The image at 1080x1350 with the official wordmark bottom-centre. */
export async function brandImage(image: Buffer): Promise<Buffer> {
  const fitted = await fitToFeed(image);
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

/** Stores an image for the chat (public file storage) and gives its URL. */
export async function storeImage(
  container: MedusaContainer,
  image: Buffer,
  filename: string,
  mimeType = 'image/jpeg',
): Promise<string> {
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
  return url;
}
