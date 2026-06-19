import path from 'path';
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { uploadFilesWorkflow } from '@medusajs/medusa/core-flows';
import sharp from 'sharp';
import { validateImage, type ImageKind } from './validate';

// POST /admin/media — validate an uploaded image and store the ORIGINAL,
// untouched, via the configured file provider (local in dev, S3/R2 in prod).
// No resize/transcode: the master is kept lossless; the storefront derives
// optimized display sizes with next/image. Returns the served URL to persist
// on the card/pack. Replaces the prior direct hit to Medusa's native
// /admin/uploads (which had no type/resolution/size gate).
//
// Auth: /admin/* is an auto-protected admin prefix, so no explicit
// authenticate() is needed here. multipart parsing + the 20 MB cap come from
// the multer middleware registered in src/api/middlewares.ts.

// Subset of the multer file shape we touch (avoids depending on the global
// Express.Multer augmentation).
type UploadedFile = {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
};

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const files = (req.files as UploadedFile[] | undefined) ?? [];
  const file = files[0];
  if (!file) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'No file uploaded.');
  }

  const rawKind = (req.body as { kind?: string } | undefined)?.kind;
  if (rawKind !== 'pack' && rawKind !== 'card' && rawKind !== 'sprite') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Field 'kind' must be 'pack', 'card', or 'sprite'.",
    );
  }
  const kind: ImageKind = rawKind;

  // Read metadata for the validation gate — never mutate the buffer.
  let meta: sharp.Metadata;
  try {
    meta = await sharp(file.buffer).metadata();
  } catch {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Could not read the image — is it a valid image file?',
    );
  }

  const verdict = validateImage(
    {
      width: meta.width ?? 0,
      height: meta.height ?? 0,
      bytes: file.size,
      mimeType: file.mimetype,
      detectedFormat: meta.format, // magic-byte sniff
      // >1 ⇒ animated (GIF/WebP). NOTE: sharp reports APNG as format "png" with
      // pages=1, so an animated PNG isn't caught here; acceptable since the set
      // is admin-controlled and the stored original is still a valid image.
      frames: meta.pages ?? 1,
    },
    kind,
  );
  if (!verdict.ok) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, verdict.message);
  }

  // Store the original bytes as-is (lossless master).
  const { result } = await uploadFilesWorkflow(req.scope).run({
    input: {
      files: [
        {
          // Strip any path components a crafted multipart filename might carry
          // (the local file provider preserves dir segments in the key) — keeps
          // writes inside the storage root. Normalize "\" → "/" first so the
          // guard is OS-agnostic (posix path.basename wouldn't split on "\").
          filename: path.basename(file.originalname.replace(/\\/g, '/')),
          mimeType: file.mimetype,
          content: file.buffer.toString('base64'),
          access: 'public',
        },
      ],
    },
  });

  const url = result?.[0]?.url;
  if (!url) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      'Upload returned no file URL.',
    );
  }

  res.json({ url });
}
