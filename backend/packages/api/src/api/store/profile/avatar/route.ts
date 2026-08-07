import path from 'path';
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import {
  deleteFilesWorkflow,
  uploadFilesWorkflow,
} from '@medusajs/medusa/core-flows';
import sharp from 'sharp';
import { validateImage } from '../../../admin/media/validate';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';

// Tighter than the shared 20 MB multer edge cap — avatars are small.
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

// Defense-in-depth on the sharp decode: even if validateImage's per-profile
// dimension cap were bypassed, refuse to materialize a raster larger than a
// generous avatar ceiling (16.7 MP >> the 2048×2048 = 4.2 MP the avatar profile
// allows, but << a 64 MP decode bomb). Bounds decode/encode CPU+RAM per request.
const AVATAR_MAX_PIXELS = 4096 * 4096;

type UploadedFile = {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
};

/**
 * The avatar route's metadata merge, factored out of the handler so the
 * cross-writer property is directly assertable without standing up sharp, the
 * file provider and the upload workflow: an avatar upload must carry every key
 * it does not own (bank_accounts, equipped_frame_level, handle) through
 * untouched.
 *
 * `previousFileId` comes out alongside the next blob rather than being read
 * separately, because the cleanup it feeds must be derived from the SAME read
 * the write is derived from — see the call site.
 */
export function mergeAvatarMetadata(
  metadata: Record<string, unknown>,
  uploaded: { url: string; fileId: string | null },
): { metadata: Record<string, unknown>; previousFileId: string | null } {
  return {
    previousFileId:
      typeof metadata.avatar_file_id === 'string'
        ? metadata.avatar_file_id
        : null,
    metadata: {
      ...metadata,
      avatar_url: uploaded.url,
      avatar_file_id: uploaded.fileId,
    },
  };
}

// POST /store/profile/avatar — the logged-in customer's profile photo.
// Same validation pipeline as /admin/media (declared-type allowlist +
// magic-byte sniff + dimension gates, 'avatar' profile) with a 5 MB cap.
// Stores the original via the configured file provider and writes
// customer.metadata.avatar_url. Metadata is MERGED (read-modify-write) so
// equipping a frame and changing the photo never clobber each other; the
// stock POST /store/customers/me rejects client metadata, so these keys are
// written only here and in /store/profile/frame. The merge runs through
// PacksModuleService.mutateCustomerMetadata so the read and the write are
// serialized on a `metadata:<customer>` advisory lock — the blob is shared with
// the saved-bank-account route, and an unlocked merge here silently drops an
// account the customer saved a moment earlier.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }

  const files = (req.files as UploadedFile[] | undefined) ?? [];
  const file = files[0];
  if (!file) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'No file uploaded.');
  }
  if (file.size > AVATAR_MAX_BYTES) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Profile photos are capped at 5 MB.',
    );
  }

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
      detectedFormat: meta.format,
      frames: meta.pages ?? 1,
    },
    'avatar',
  );
  if (!verdict.ok) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, verdict.message);
  }

  // Re-encode before storing: a phone photo carries EXIF (often GPS) and this
  // image is served on PUBLIC surfaces (profile/leaderboard). sharp strips all
  // metadata unless withMetadata() is opted into; .rotate() bakes in the EXIF
  // orientation first so the strip doesn't sideways-flip portrait shots.
  let clean: Buffer;
  try {
    clean = await sharp(file.buffer, { limitInputPixels: AVATAR_MAX_PIXELS })
      .rotate()
      .webp({ quality: 90 })
      .toBuffer();
  } catch {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Could not process the image — try a different photo.',
    );
  }

  const { result } = await uploadFilesWorkflow(req.scope).run({
    input: {
      files: [
        {
          // Strip path components a crafted multipart filename might carry
          // (same guard as /admin/media), then swap the extension for the
          // re-encoded webp we actually store.
          filename:
            path
              .basename(file.originalname.replace(/\\/g, '/'))
              .replace(/\.[a-z0-9]+$/i, '') + '.webp',
          mimeType: 'image/webp',
          content: clean.toString('base64'),
          access: 'public',
        },
      ],
    },
  });
  const uploaded = result?.[0];
  const url = uploaded?.url;
  if (!url) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      'Upload returned no file URL.',
    );
  }

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const customers = req.scope.resolve(Modules.CUSTOMER);
  // Provider file id of the photo being replaced — avatars uploaded before this
  // field existed have none and are simply left in place. Captured from the
  // blob read INSIDE the lock: a pre-lock read could name a file a concurrent
  // upload has already replaced, and the cleanup below would delete the LIVE
  // photo.
  const replaced: { fileId: string | null } = { fileId: null };
  await packs.mutateCustomerMetadata({
    customerId,
    customers,
    mutate: (metadata) => {
      const merged = mergeAvatarMetadata(metadata, {
        url,
        fileId: uploaded.id ?? null,
      });
      replaced.fileId = merged.previousFileId;
      return merged.metadata;
    },
  });

  // Best-effort cleanup of the replaced photo so re-uploads don't accumulate
  // orphaned objects in the file provider — never fail the upload over it.
  // Deliberately OUTSIDE the mutator: a file-provider round trip must not be
  // held under the metadata lock, and its swallowed failure must stay swallowed
  // rather than becoming a transaction rollback.
  if (replaced.fileId && replaced.fileId !== uploaded.id) {
    await deleteFilesWorkflow(req.scope)
      .run({ input: { ids: [replaced.fileId] } })
      .catch(() => undefined);
  }

  res.json({ avatar_url: url });
}
