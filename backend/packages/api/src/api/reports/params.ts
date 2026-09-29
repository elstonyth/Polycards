import type { MedusaRequest } from '@medusajs/framework/http';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { isDefaultPlayerGroup } from '../../modules/packs/odds-sets';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Half-open [from, to) of ISO instants; an absent bound is open-ended. */
export type ReportWindow = { from?: string; to?: string };

const invalid = (message: string) =>
  new MedusaError(MedusaError.Types.INVALID_DATA, message);

/**
 * ?from=&to= as a report window. Unlike /admin/economy (which drops a
 * malformed bound), a bad bound is a 400: a bot asking for "today" must never
 * silently receive all-time numbers.
 */
export function parseWindow(
  query: Record<string, unknown>,
  opts: { required?: boolean; maxDays?: number } = {},
): ReportWindow {
  const bound = (key: 'from' | 'to'): string | undefined => {
    const value = query[key];
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      throw invalid(
        `${key} must be one ISO date-time, e.g. 2026-09-28T16:00:00.000Z.`,
      );
    }
    return new Date(value).toISOString();
  };
  const from = bound('from');
  const to = bound('to');
  if (opts.required && (!from || !to)) {
    throw invalid('from and to are both required.');
  }
  if (from && to && from >= to) throw invalid('from must be before to.');
  if (
    opts.maxDays &&
    from &&
    to &&
    Date.parse(to) - Date.parse(from) > opts.maxDays * DAY_MS
  ) {
    throw invalid(`The window can be at most ${opts.maxDays} days.`);
  }
  return { from, to };
}

/** Which players a report counts, by their EFFECTIVE player group (the rule
 *  in modules/packs/odds-sets.ts: oldest non-default membership). */
export type GroupScope =
  | { kind: 'all' }
  | { kind: 'default' }
  | { kind: 'group'; id: string; name: string };

export type GroupRow = {
  id: string;
  name: string | null;
  metadata?: Record<string, unknown> | null;
};

/**
 * ?group= as a scope: absent or 'all' = everyone; 'default' = players whose
 * effective group is DEFAULT (in no other group); anything else names a
 * group, case-insensitively. Naming a default group itself (DEFAULT, or a
 * renamed one carrying the is_default flag) also means 'default'. The words
 * 'all' and 'default' win over a group that happens to be called that.
 */
export function resolveGroupScope(
  raw: unknown,
  groups: readonly GroupRow[],
): GroupScope {
  if (raw !== undefined && typeof raw !== 'string') {
    throw invalid('group must be one value.');
  }
  const wanted = typeof raw === 'string' ? raw.trim() : '';
  const key = wanted.toLowerCase();
  if (key === '' || key === 'all') return { kind: 'all' };
  if (key === 'default') return { kind: 'default' };
  const match = groups.find((g) => (g.name ?? '').trim().toLowerCase() === key);
  if (!match) {
    const names = groups
      .map((g) => g.name)
      .filter((name): name is string => !!name);
    throw invalid(
      `Unknown player group "${wanted.slice(0, 60)}". Use all, default, or one of: ${names.join(', ')}.`,
    );
  }
  if (isDefaultPlayerGroup(match)) return { kind: 'default' };
  return { kind: 'group', id: match.id, name: match.name ?? match.id };
}

/** Says in words who a report counted, so the bot can repeat it. */
export function describeScope(scope: GroupScope): {
  group: string;
  note: string;
} {
  if (scope.kind === 'all') return { group: 'all', note: 'All players.' };
  if (scope.kind === 'default') {
    return {
      group: 'DEFAULT',
      note: 'Players whose current player group is DEFAULT, i.e. in no other group.',
    };
  }
  return {
    group: scope.name,
    note: `Players whose current player group is ${scope.name}.`,
  };
}

/** The request's ?group= resolved against the live group list (the same
 *  100-group ceiling modules/packs/player-groups.ts assumes). */
export async function loadGroupScope(req: MedusaRequest): Promise<GroupScope> {
  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const groups = await customers.listCustomerGroups(
    {},
    { take: 100, order: { created_at: 'ASC' } },
  );
  return resolveGroupScope(req.query.group, groups);
}
