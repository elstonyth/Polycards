import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { defineWidgetConfig } from '@mercurjs/dashboard-sdk';
import { DataTable } from '@mercurjs/dashboard-shared';
import {
  Button,
  Checkbox,
  Container,
  FocusModal,
  Heading,
  Input,
  Label,
  StatusBadge,
  Text,
  Textarea,
  usePrompt,
  type DataTableColumnDef,
} from '@medusajs/ui';
import { rm } from '../lib/format';
import { qk } from '../lib/query-keys';
import type { GroupCreditCustomer } from '../lib/admin-rest';
import {
  createGroupCreditAdjustment,
  loadGroupCreditCustomers,
  parseGroupCreditAmount,
  runGroupCreditAdjustment,
  type GroupCreditAdjustment,
  type GroupCreditResults,
} from '../lib/group-credit-edit';

type Props = { data: { id: string; name: string } };

function GroupCreditEditor({ data: group }: Props) {
  const { t } = useTranslation();
  const prompt = usePrompt();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const running = useRef(false);
  const confirming = useRef(false);
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [amountText, setAmountText] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [batch, setBatch] = useState<GroupCreditAdjustment | null>(null);
  const [results, setResults] = useState<GroupCreditResults>({});
  const members = useQuery({
    queryKey: ['group-credit-customers', group.id],
    queryFn: () => loadGroupCreditCustomers(group.id),
    enabled: open && !batch,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const customers = members.data ?? [];
  const selectedCount = customers.filter((customer) =>
    selected.has(customer.id),
  ).length;
  const amount = parseGroupCreditAmount(amountText);
  const succeeded = Object.values(results).filter(
    (result) => result.status === 'succeeded',
  ).length;
  const failed = Object.values(results).filter(
    (result) => result.status === 'failed',
  ).length;
  const visible = (batch?.customers ?? customers).filter(
    (customer) =>
      batch ||
      `${customer.email ?? ''} ${customer.first_name ?? ''} ${customer.last_name ?? ''}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  const canSubmit =
    !busy &&
    !members.isFetching &&
    !members.isError &&
    selectedCount > 0 &&
    amount !== null &&
    note.trim().length > 0 &&
    note.trim().length <= 512;
  const offset = Number(searchParams.get('group_credits_offset')) || 0;
  const resetPage = () =>
    setSearchParams(
      (current) => {
        current.delete('group_credits_offset');
        return current;
      },
      { replace: true },
    );
  const columns: DataTableColumnDef<GroupCreditCustomer>[] = [
    ...(!batch
      ? [
          {
            id: 'select',
            header: () => (
              <span className="sr-only">{t('groupCredits.select')}</span>
            ),
            cell: ({ row }: { row: { original: GroupCreditCustomer } }) => (
              <Checkbox
                aria-label={t('groupCredits.selectPlayer', {
                  name:
                    row.original.first_name ||
                    row.original.email ||
                    row.original.id,
                })}
                checked={selected.has(row.original.id)}
                disabled={busy}
                onCheckedChange={(checked) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (checked === true) next.add(row.original.id);
                    else next.delete(row.original.id);
                    return next;
                  })
                }
              />
            ),
          },
        ]
      : []),
    {
      id: 'player',
      header: t('groupCredits.player'),
      cell: ({ row }) =>
        [row.original.first_name, row.original.last_name]
          .filter(Boolean)
          .join(' ') ||
        row.original.email ||
        row.original.id,
    },
    {
      accessorKey: 'email',
      header: t('groupCredits.email'),
      cell: ({ row }) => row.original.email ?? '—',
    },
    ...(batch
      ? [
          {
            id: 'result',
            header: t('groupCredits.status'),
            cell: ({ row }: { row: { original: GroupCreditCustomer } }) => {
              const result = results[row.original.id];
              return (
                <StatusBadge
                  color={
                    result?.status === 'succeeded'
                      ? 'green'
                      : result?.status === 'failed'
                        ? 'red'
                        : 'grey'
                  }
                >
                  {result?.status === 'succeeded'
                    ? t('groupCredits.applied', { balance: rm(result.balance) })
                    : result?.status === 'failed'
                      ? result.message
                      : t('groupCredits.pending')}
                </StatusBadge>
              );
            },
          },
        ]
      : []),
  ];

  const execute = async (
    snapshot: GroupCreditAdjustment,
    previous: GroupCreditResults,
  ) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await runGroupCreditAdjustment(snapshot, previous, setResults);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'customer'] });
      void queryClient.invalidateQueries({ queryKey: qk.playersKey });
      void queryClient.invalidateQueries({ queryKey: qk.economy });
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!canSubmit || confirming.current) return;
    const snapshot = createGroupCreditAdjustment(
      customers,
      selected,
      amountText,
      note,
    );
    if (!snapshot) return;
    confirming.current = true;
    setBusy(true);
    try {
      const accepted = await prompt({
        title: t('groupCredits.confirmTitle'),
        variant: 'confirmation',
        description: t('groupCredits.confirmDescription', {
          group: group.name,
          count: snapshot.customers.length,
          amount: rm(snapshot.amount),
          total: rm(
            (Math.round(snapshot.amount * 100) * snapshot.customers.length) /
              100,
          ),
          note: snapshot.note,
        }),
        confirmText: t('groupCredits.apply'),
        cancelText: t('groupCredits.cancel'),
      });
      if (!accepted) return;
      resetPage();
      setBatch(snapshot);
      setResults({});
      await execute(snapshot, {});
    } finally {
      confirming.current = false;
      setBusy(false);
    }
  };

  const startNew = async () => {
    if (busy || confirming.current || running.current) return;
    if (failed) {
      confirming.current = true;
      setBusy(true);
      try {
        const accepted = await prompt({
          variant: 'confirmation',
          title: t('groupCredits.newAdjustment'),
          description: t('groupCredits.discardFailures'),
          confirmText: t('groupCredits.newAdjustment'),
          cancelText: t('groupCredits.cancel'),
        });
        if (!accepted) return;
      } finally {
        confirming.current = false;
        setBusy(false);
      }
    }
    resetPage();
    setBatch(null);
    setResults({});
    setSelected(new Set());
    setAmountText('');
    setNote('');
    setSearch('');
  };

  return (
    <>
      <Container className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <Heading level="h2">{t('groupCredits.title')}</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            {t('groupCredits.description')}
          </Text>
        </div>
        <Button
          size="small"
          variant="secondary"
          onClick={() => {
            resetPage();
            setOpen(true);
          }}
        >
          {batch && failed
            ? t('groupCredits.viewResults')
            : t('groupCredits.edit')}
        </Button>
      </Container>
      <FocusModal
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <FocusModal.Content
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <FocusModal.Header>
            <div className="flex items-center gap-2">
              <Button
                size="small"
                variant="secondary"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                {t('groupCredits.close')}
              </Button>
              {batch ? (
                <>
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void startNew()}
                  >
                    {t('groupCredits.newAdjustment')}
                  </Button>
                  {failed > 0 && (
                    <Button
                      size="small"
                      disabled={busy}
                      isLoading={busy}
                      onClick={() => void execute(batch, results)}
                    >
                      {t('groupCredits.retryFailed', { count: failed })}
                    </Button>
                  )}
                </>
              ) : (
                <Button
                  size="small"
                  disabled={!canSubmit}
                  isLoading={busy}
                  onClick={() => void confirm()}
                >
                  {t('groupCredits.review')}
                </Button>
              )}
            </div>
          </FocusModal.Header>
          <FocusModal.Body className="flex flex-col items-center overflow-auto p-4 sm:p-10">
            <div className="flex w-full max-w-[900px] flex-col gap-6">
              <div>
                <FocusModal.Title asChild>
                  <Heading level="h2">{t('groupCredits.edit')}</Heading>
                </FocusModal.Title>
                <FocusModal.Description asChild>
                  <Text size="small" className="text-ui-fg-subtle mt-1">
                    {group.name} · {t('groupCredits.description')}
                  </Text>
                </FocusModal.Description>
              </div>
              {batch ? (
                <div className="flex flex-col gap-2" aria-live="polite">
                  <Text>
                    {t('groupCredits.batchSummary', {
                      amount: rm(batch.amount),
                      count: batch.customers.length,
                      total: rm(
                        (Math.round(batch.amount * 100) *
                          batch.customers.length) /
                          100,
                      ),
                    })}
                  </Text>
                  <Text size="small">
                    {t('groupCredits.note')}: {batch.note}
                  </Text>
                  <Text>
                    {t(
                      busy ? 'groupCredits.progress' : 'groupCredits.results',
                      {
                        done: Object.keys(results).length,
                        count: batch.customers.length,
                        succeeded,
                        failed,
                      },
                    )}
                  </Text>
                  {failed > 0 && (
                    <Text size="small" className="text-ui-fg-subtle">
                      {t('groupCredits.retryHint')}
                    </Text>
                  )}
                </div>
              ) : (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="flex flex-col gap-2">
                      <Label htmlFor={`${fieldId}-amount`}>
                        {t('groupCredits.amount')}
                      </Label>
                      <Input
                        id={`${fieldId}-amount`}
                        type="number"
                        step="0.01"
                        min="-1000000"
                        max="1000000"
                        placeholder="100.00"
                        value={amountText}
                        disabled={busy}
                        onChange={(event) => setAmountText(event.target.value)}
                        aria-describedby={`${fieldId}-amount-hint`}
                      />
                      <Text
                        id={`${fieldId}-amount-hint`}
                        size="small"
                        className="text-ui-fg-subtle"
                      >
                        {t('groupCredits.amountHint')}
                      </Text>
                      {amountText && amount === null && (
                        <Text size="small" className="text-ui-fg-error">
                          {t('groupCredits.invalidAmount')}
                        </Text>
                      )}
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label htmlFor={`${fieldId}-note`}>
                        {t('groupCredits.note')}
                      </Label>
                      <Textarea
                        id={`${fieldId}-note`}
                        aria-required="true"
                        maxLength={512}
                        value={note}
                        disabled={busy}
                        onChange={(event) => setNote(event.target.value)}
                      />
                    </div>
                  </div>
                  {members.isFetching ? (
                    <Text role="status">{t('groupCredits.loading')}</Text>
                  ) : members.isError ? (
                    <div className="flex items-center gap-3" role="alert">
                      <Text className="text-ui-fg-error">
                        {t('groupCredits.loadError')}
                      </Text>
                      <Button
                        size="small"
                        variant="secondary"
                        onClick={() => void members.refetch()}
                      >
                        {t('groupCredits.reload')}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={`${fieldId}-all`}
                          disabled={busy || !customers.length}
                          checked={
                            selectedCount === customers.length &&
                            customers.length > 0
                              ? true
                              : selectedCount > 0
                                ? 'indeterminate'
                                : false
                          }
                          onCheckedChange={(checked) =>
                            setSelected(
                              checked === true
                                ? new Set(
                                    customers.map((customer) => customer.id),
                                  )
                                : new Set(),
                            )
                          }
                        />
                        <Label htmlFor={`${fieldId}-all`}>
                          {t('groupCredits.selectAll', {
                            count: customers.length,
                          })}
                        </Label>
                        <Text size="small" className="text-ui-fg-subtle">
                          {t('groupCredits.selected', { count: selectedCount })}
                        </Text>
                      </div>
                      <Input
                        className="max-w-[280px]"
                        aria-label={t('groupCredits.search')}
                        placeholder={t('groupCredits.search')}
                        value={search}
                        disabled={busy}
                        onChange={(event) => {
                          resetPage();
                          setSearch(event.target.value);
                        }}
                      />
                    </div>
                  )}
                </>
              )}
              {(batch || (!members.isFetching && !members.isError)) && (
                <DataTable
                  data={visible.slice(offset, offset + 25)}
                  columns={columns}
                  getRowId={(customer) => customer.id}
                  rowCount={visible.length}
                  pageSize={25}
                  prefix="group_credits"
                  enableSearch={false}
                  enableFilterMenu={false}
                  emptyState={{ empty: { heading: t('groupCredits.empty') } }}
                />
              )}
            </div>
          </FocusModal.Body>
        </FocusModal.Content>
      </FocusModal>
    </>
  );
}

export function CustomerGroupCredits({ data }: Props) {
  return <GroupCreditEditor key={data.id} data={data} />;
}

export const config = defineWidgetConfig({
  zone: 'customer-groups.detail.main.before',
});
export default CustomerGroupCredits;
