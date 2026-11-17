// Who may unban a bank number the player never held, found on the ban list
// (security review): admins, not the Support viewer. So may freeing a number
// from other accounts and clearing a shared name (owner, 2026-11-04: admins
// only): they change other accounts, or let a name past them. One rule for
// the player page's unban-number route and the assistant's bank tools.

type Policy = { resource: string; operation: string };

/** The policy those need beside the unban policy. */
export const BAN_LIST_NEED: Policy = {
  resource: 'customer',
  operation: 'update',
};

/** A super admin, or a role holding BAN_LIST_NEED. With no way to ask the
 *  roles, only a super admin. */
export async function fromBanList(access: {
  superAdmin: boolean;
  can?(need: Policy): Promise<boolean>;
}): Promise<boolean> {
  return access.superAdmin || ((await access.can?.(BAN_LIST_NEED)) ?? false);
}
