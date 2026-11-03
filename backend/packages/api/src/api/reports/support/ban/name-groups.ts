// Holder-name groups for the ban report (route.ts), kept out of the route file
// so it can be tested on its own.

/** A group number per account: accounts linked by a shared holder name, even
 *  through a third account that used both names, read the same number, counted
 *  1, 2, 3 in the order the accounts are listed. null = no name on file. */
export function nameGroups(
  rows: { customer_id: string; keys: string[] | null }[],
): Map<string, number | null> {
  // Union-find over the names.
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    parent.set(k, root);
    return root;
  };
  for (const row of rows) {
    const keys = row.keys ?? [];
    for (const k of keys) if (!parent.has(k)) parent.set(k, k);
    for (const k of keys.slice(1)) parent.set(find(k), find(keys[0]));
  }
  const number = new Map<string, number>();
  const out = new Map<string, number | null>();
  for (const row of rows) {
    const first = row.keys?.[0];
    if (first === undefined) {
      out.set(row.customer_id, null);
      continue;
    }
    const root = find(first);
    if (!number.has(root)) number.set(root, number.size + 1);
    out.set(row.customer_id, number.get(root) as number);
  }
  return out;
}
