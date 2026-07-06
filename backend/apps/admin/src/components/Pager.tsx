import { Button, Text } from '@medusajs/ui';

// Offset pager for admin tables. total=null means the server did not report
// one; in that case "Next" stays enabled while the current page is full.
export const Pager = ({
  page,
  onPage,
  pageSize,
  count,
  total,
}: {
  page: number;
  onPage: (p: number) => void;
  pageSize: number;
  count: number;
  total: number | null;
}) => {
  const from = count === 0 ? 0 : page * pageSize + 1;
  const to = page * pageSize + count;
  const hasMore =
    total !== null ? (page + 1) * pageSize < total : count === pageSize;
  return (
    <div className="flex items-center justify-between border-t px-6 py-3">
      <Text size="small" className="text-ui-fg-subtle tabular-nums">
        {total !== null
          ? `${from}–${to} of ${total.toLocaleString('en-US')}`
          : `${from}–${to}`}
      </Text>
      <div className="flex gap-2">
        <Button
          size="small"
          variant="secondary"
          disabled={page === 0}
          onClick={() => onPage(page - 1)}
        >
          Prev
        </Button>
        <Button
          size="small"
          variant="secondary"
          disabled={!hasMore}
          onClick={() => onPage(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
};
