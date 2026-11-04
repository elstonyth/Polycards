import type PacksModuleService from '../../../modules/packs/service';

// Who the person named in THIS message (security review 2026-11-03): a name in
// data the model read (a customer field, a past chat) must not start a change,
// so every change tool checks its player against the message itself.

const fold = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A name ends where letters, digits, _ and - stop: Collector1 is not named by
// a message naming Collector12, and Chinese around a name does not hide it.
const EDGE = '[^a-z0-9_-]';

/** Is `name` in `text` as a whole word or phrase ("Ah Boy 88"), any case? */
export function namedIn(text: string, name: string): boolean {
  const n = fold(name.replace(/^@/, ''));
  return (
    n !== '' &&
    new RegExp(`(^|${EDGE})${escape(n)}($|${EDGE})`).test(fold(text))
  );
}

/** "@name" in the message: the person means a profile handle. */
const handleIn = (text: string, name: string): boolean =>
  new RegExp(
    `(^|${EDGE})@${escape(fold(name.replace(/^@/, '')))}($|${EDGE})`,
  ).test(fold(text));

/**
 * The player the person named in this message, by shown name or profile
 * handle. A shown name that is another player's handle (2026-11-04: one player
 * shown under the handle of a banned account) is
 * settled by "@name" in the message (the handle), then by `pick` (unban picks
 * the one that is banned), else refused. Throws with `tail` appended. A read
 * (`readOnly`) may name anyone, and "@" sent with the name means the handle.
 */
export async function namedPlayer(
  packs: Pick<
    PacksModuleService,
    'findCustomerIdByUsername' | 'findCustomerIdByHandle'
  >,
  username: string,
  text: string,
  tail: string,
  opts: {
    pick?: (byName: string, byHandle: string) => Promise<string | null>;
    readOnly?: boolean;
  } = {},
): Promise<string> {
  const name = username.trim().replace(/^@/, '');
  if (!name || (!opts.readOnly && !namedIn(text, name))) {
    throw new Error(
      `Act only for a player the person named in this message. ${tail}`,
    );
  }
  const byHandle = await packs.findCustomerIdByHandle(name);
  // "@" settles a clash; with no such handle, it was just a way to write a name.
  if (
    byHandle &&
    (handleIn(text, name) || (opts.readOnly && username.trim().startsWith('@')))
  ) {
    return byHandle;
  }
  const byName = await packs.findCustomerIdByUsername(name);
  if (byName && byHandle && byName !== byHandle) {
    const picked = opts.pick ? await opts.pick(byName, byHandle) : null;
    if (picked) return picked;
    throw new Error(
      `${name} is one player's shown name and a different player's handle. Ask staff to write @${name} for the handle, or the other player's shown name. ${tail}`,
    );
  }
  const id = byName ?? byHandle;
  if (!id) throw new Error(`No player named ${name}. ${tail}`);
  return id;
}
