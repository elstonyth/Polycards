import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { deleteFilesWorkflow } from '@medusajs/medusa/core-flows';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { mergeAvatarMetadata } from '../route';

// The storefront's catalog: public/images/avatars/avatar-1..80.webp, mirrored
// by AVATAR_COUNT in src/lib/avatar-seed.ts.
const PRESET_AVATAR_COUNT = 80;

// POST /store/profile/avatar/preset { id: 1..80 } — switch to a catalog avatar.
// Takes an id, never a URL: the client must not be able to store an arbitrary
// avatar_url (that is what the reserved-key guard on customer metadata is for),
// so the stored path is built here. It is a storefront-relative path, which
// every reader of avatar_url hands straight to an <img> on the storefront.
//
// A customer who never picks one has no stored avatar at all: the storefront
// assigns one from their seed (avatarForSeed), so nothing here runs for them.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }

  const id = (req.body as { id?: unknown } | null)?.id;
  if (
    typeof id !== 'number' ||
    !Number.isInteger(id) ||
    id < 1 ||
    id > PRESET_AVATAR_COUNT
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `id must be a whole number from 1 to ${PRESET_AVATAR_COUNT}.`,
    );
  }
  const url = `/images/avatars/avatar-${id}.webp`;

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  // Read inside the lock, for the reason the upload route spells out.
  const replaced: { fileId: string | null } = { fileId: null };
  await packs.mutateCustomerMetadata({
    customerId,
    mutate: (metadata) => {
      const merged = mergeAvatarMetadata(metadata, { url, fileId: null });
      replaced.fileId = merged.previousFileId;
      return merged.metadata;
    },
  });

  // Same best-effort cleanup as replacing a photo with a photo: an uploaded
  // photo nothing points at any more is only an orphan in the bucket.
  if (replaced.fileId) {
    await deleteFilesWorkflow(req.scope)
      .run({ input: { ids: [replaced.fileId] } })
      .catch(() => undefined);
  }

  res.json({ avatar_url: url });
}
