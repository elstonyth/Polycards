import { useEffect, useState } from 'react';
import { Checkbox, IconButton, Input, Text } from '@medusajs/ui';
import { XMark } from '@medusajs/icons';
import { useInventory } from '../../lib/queries';
import { resolveImageUrl } from '../../lib/image-url';
import { rm } from '../../lib/format';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { poolCardFrom, prizeCards, type PoolCard } from './prize-pool';

// The route truncates ?q= at 100 chars; the input's maxLength matches.
const MAX_Q = 100;
// Rows drawn at once. The list is one unpaged catalog read, so a blank search
// can be long; the search box is how to reach the rest.
const MAX_ROWS = 200;

const Thumb = ({ src }: { src: string | null }) =>
  src ? (
    <img
      src={resolveImageUrl(src)}
      alt=""
      loading="lazy"
      decoding="async"
      className="h-10 w-7 shrink-0 rounded object-contain"
    />
  ) : (
    <div className="bg-ui-bg-subtle h-10 w-7 shrink-0 rounded" />
  );

// The card's RM value (the inventory row's price), as the rest of admin writes
// money; "—" when no FMV is recorded.
const Value = ({ n }: { n: number | null }) => (
  <Text size="small" className="shrink-0">
    <span className="text-ui-fg-subtle">Value </span>
    {rm(n)}
  </Text>
);

/** Pick prize cards from the inventory: any registered card, searched on the
 *  server, any number ticked. Picking holds no stock — the card is minted to
 *  the winner at draw time, like a challenge card prize. */
export const InventoryPicker = ({
  selected,
  onChange,
  canAddMore,
}: {
  selected: PoolCard[];
  onChange: (next: PoolCard[]) => void;
  /** false once the pool is full: ticked rows can still be unticked. */
  canAddMore: boolean;
}) => {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  // The endpoint pages the whole catalog per request (see the Inventory page),
  // so a request per keystroke is not an option.
  useEffect(() => {
    const id = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);

  const { data, isError } = useInventory(q || undefined);
  const rows = prizeCards(data?.rows ?? []);
  const picked = new Set(selected.map((c) => c.handle));

  const toggle = (handle: string) => {
    const row = rows.find((r) => r.handle === handle);
    if (picked.has(handle)) {
      onChange(selected.filter((c) => c.handle !== handle));
    } else if (row && canAddMore) {
      onChange([...selected, poolCardFrom(row)]);
    }
  };

  return (
    <div className="flex flex-col gap-y-3">
      {selected.length > 0 && (
        <ul className="flex flex-col gap-y-2">
          {selected.map((c) => (
            <li key={c.handle} className="flex items-center gap-x-3">
              <Thumb src={c.photo} />
              <div className="min-w-0 flex-1">
                <Input
                  size="small"
                  aria-label={`Prize title for ${c.name}`}
                  value={c.title}
                  maxLength={120}
                  onChange={(e) =>
                    onChange(
                      selected.map((x) =>
                        x.handle === c.handle
                          ? { ...x, title: e.target.value }
                          : x,
                      ),
                    )
                  }
                  placeholder={c.name}
                />
              </div>
              <Value n={c.value} />
              <IconButton
                size="small"
                variant="transparent"
                aria-label={`Remove ${c.name}`}
                onClick={() =>
                  onChange(selected.filter((x) => x.handle !== c.handle))
                }
              >
                <XMark />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      <Input
        size="small"
        aria-label="Search inventory"
        value={search}
        maxLength={MAX_Q}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search cards…"
      />

      <div
        className="border-ui-border-base max-h-64 overflow-y-auto rounded-md border"
        role="group"
        aria-label="Cards"
      >
        {isError ? (
          <Text size="small" className="text-ui-fg-error p-3">
            Failed to load the inventory.
          </Text>
        ) : !data ? (
          <div className="p-3">
            <LoadingSkeleton rows={3} />
          </div>
        ) : rows.length === 0 ? (
          <Text size="small" className="text-ui-fg-subtle p-3">
            {q ? 'No card matches.' : 'No card is registered yet.'}
          </Text>
        ) : (
          <ul className="divide-ui-border-base divide-y">
            {rows.slice(0, MAX_ROWS).map((r) => (
              <li key={r.handle}>
                <label className="hover:bg-ui-bg-base-hover flex cursor-pointer items-center gap-x-3 px-3 py-2">
                  <Checkbox
                    checked={picked.has(r.handle)}
                    disabled={!picked.has(r.handle) && !canAddMore}
                    onCheckedChange={() => toggle(r.handle)}
                  />
                  <Thumb src={r.photo} />
                  <Text size="small" className="min-w-0 flex-1 truncate">
                    {r.name}
                  </Text>
                  <Value n={r.price} />
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      {rows.length > MAX_ROWS && (
        <Text size="small" className="text-ui-fg-subtle">
          Showing the first {MAX_ROWS} of {rows.length} — search to narrow it
          down.
        </Text>
      )}
    </div>
  );
};
