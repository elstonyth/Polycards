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

// Lookups a change may cost before it asks for the handle instead.
const MAX_OTHER_WORDS = 40;

/**
 * Throws unless `id` is the only player this message names (security audit
 * 2026-11-09): a shown name can be an ordinary word ("Maybank", "unban"), so
 * the word the model picked must not be one of several players in the text.
 * Each other word shaped like a shown name or handle (utils/profile-handle.ts)
 * is looked up; staff settle it with "@handle", which never reaches here.
 * shortcut: older names with spaces or other scripts are not looked up
 * elsewhere in the text; upgrade to a name scan in SQL if those still act.
 */
async function noOtherPlayerIn(
  packs: Pick<
    PacksModuleService,
    'findCustomerIdByUsername' | 'findCustomerIdByHandle'
  >,
  text: string,
  name: string,
  id: string,
  tail: string,
): Promise<void> {
  const rest = fold(text).replace(
    new RegExp(`(?<![a-z0-9_-])${escape(fold(name))}(?![a-z0-9_-])`, 'g'),
    ' ',
  );
  const words = [
    ...new Set(
      (rest.match(/[a-z0-9_-]+/g) ?? []).filter(
        (w) => w.length >= 3 && w.length <= 30,
      ),
    ),
  ];
  const ask = `Ask staff to name the player by their exact handle, as @handle. ${tail}`;
  if (words.length > MAX_OTHER_WORDS) {
    throw new Error(
      `This message is too long to be sure which player is meant. ${ask}`,
    );
  }
  for (const word of words) {
    const ids = await Promise.all([
      packs.findCustomerIdByUsername(word),
      packs.findCustomerIdByHandle(word),
    ]);
    if (ids.some((other) => other && other !== id)) {
      throw new Error(
        `"${word}" in this message is another player too, so it is not clear which player is meant. ${ask}`,
      );
    }
  }
}

/**
 * The player the person named in this message, by shown name or profile
 * handle. A shown name that is another player's handle (2026-11-04: one player
 * shown under the handle of a banned account) is
 * settled by "@name" in the message (the handle), then by `pick` (unban picks
 * the one that is banned), else refused. A change is refused too when another
 * word of the message is a different player, unless staff wrote "@handle".
 * Throws with `tail` appended. A read
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
  let id = byName ?? byHandle;
  if (byName && byHandle && byName !== byHandle) {
    id = opts.pick ? await opts.pick(byName, byHandle) : null;
    if (!id) {
      throw new Error(
        `${name} is one player's shown name and a different player's handle. Ask staff to write @${name} for the handle, or the other player's shown name. ${tail}`,
      );
    }
  }
  if (!id) throw new Error(`No player named ${name}. ${tail}`);
  if (!opts.readOnly) await noOtherPlayerIn(packs, text, name, id, tail);
  return id;
}
