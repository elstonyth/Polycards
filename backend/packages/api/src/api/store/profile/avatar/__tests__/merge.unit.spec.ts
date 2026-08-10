import { mergeAvatarMetadata } from '../route';

/**
 * The cross-writer case, single-threaded: `customer.metadata` is ONE blob
 * shared by the avatar route, the frame route, the saved-bank-account route and
 * the profile-handle workflow step. An avatar upload owns exactly two keys and
 * must carry every other key through byte-for-byte — dropping one is the
 * silent-data-loss bug the metadata lock exists to make impossible under
 * concurrency, and this pins the merge itself so the lock is not the only thing
 * standing between a customer and a vanished bank account.
 */
describe('mergeAvatarMetadata', () => {
  const UPLOAD = { url: 'https://cdn/new.webp', fileId: 'file_new' };

  it('carries every key it does not own through untouched', () => {
    const { metadata } = mergeAvatarMetadata(
      {
        bank_accounts: [{ id: 'acc_1' }],
        equipped_frame_level: 40,
        handle: 'tan-ah-kow',
        avatar_url: 'https://cdn/old.webp',
        avatar_file_id: 'file_old',
      },
      UPLOAD,
    );
    expect(metadata).toEqual({
      bank_accounts: [{ id: 'acc_1' }],
      equipped_frame_level: 40,
      handle: 'tan-ah-kow',
      avatar_url: 'https://cdn/new.webp',
      avatar_file_id: 'file_new',
    });
  });

  it('reports the replaced provider file id from the SAME blob it merges', () => {
    const { previousFileId } = mergeAvatarMetadata(
      { avatar_file_id: 'file_old' },
      UPLOAD,
    );
    // Read out of the merged blob rather than fetched separately: the cleanup
    // this feeds deletes a file, and a pre-lock read could name one a
    // concurrent upload already replaced — i.e. delete the LIVE photo.
    expect(previousFileId).toBe('file_old');
  });

  it('reports null when the blob predates avatar_file_id, so nothing is deleted', () => {
    expect(
      mergeAvatarMetadata({ avatar_url: 'https://cdn/legacy.webp' }, UPLOAD)
        .previousFileId,
    ).toBeNull();
    // Not a string (e.g. a malformed blob) is treated the same way.
    expect(
      mergeAvatarMetadata({ avatar_file_id: 42 }, UPLOAD).previousFileId,
    ).toBeNull();
  });

  it('does not mutate the blob it was given', () => {
    const before = { bank_accounts: [{ id: 'acc_1' }] };
    mergeAvatarMetadata(before, UPLOAD);
    expect(before).toEqual({ bank_accounts: [{ id: 'acc_1' }] });
  });
});
