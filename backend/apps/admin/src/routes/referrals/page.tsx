import { useState } from 'react';
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Table,
  Text,
  toast,
  usePrompt,
} from '@medusajs/ui';
import { Users } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import {
  useApproveReferralSettlement,
  usePayReferralSettlement,
  useReferralSettings,
  useReferralSettlement,
  useReferralSettlements,
  useUpdateReferralSettings,
  useVoidReferralLine,
  type ReferralSettings,
  type ReferralSettlement,
} from '../../lib/queries';
import {
  tierRowsToPayload,
  validateTierRows,
  type TierRow,
} from '../../lib/referral-tiers';
import { rm } from '../../lib/format';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

// Referrals — the weekly commission engine's operator console (rebuild, spec
// 2026-08-24). Three cards: the tier table + partner bounds, the settlement
// run list ("TUES CHECK" happens here: review, then Approve), and the
// selected run's line detail with per-line void.
export const config: RouteConfig = {
  label: 'Referrals',
  icon: Users,
  // After Settlement (34) — the money-reporting cluster's tail.
  rank: 35,
};

const fromCents = (cents: number): string => rm(cents / 100);
const pctLabel = (bp: number): string => `${(bp / 100).toFixed(2)}%`;

const STATUS_COLOR: Record<
  ReferralSettlement['status'],
  'grey' | 'orange' | 'green' | 'red'
> = {
  draft: 'orange',
  approved: 'grey',
  paid: 'green',
  void: 'red',
};

// Mounted only once the settings are in hand, so every input seeds from a
// useState initialiser (BankForm precedent — an effect-seeded form races the
// operator's typing on every background refetch, and the React Compiler lint
// rejects setState-in-effect).
function SettingsCard() {
  const { data, isLoading } = useReferralSettings();
  if (isLoading || !data) {
    return <LoadingSkeleton rows={4} />;
  }
  return <SettingsEditor initial={data} />;
}

function SettingsEditor({ initial }: { initial: ReferralSettings }) {
  const update = useUpdateReferralSettings();
  const [rows, setRows] = useState<TierRow[]>(() =>
    initial.tiers.map((t) => ({
      minRm: String(t.min_cents / 100),
      ratePct: String(t.rate_bp / 100),
    })),
  );
  const [minPct, setMinPct] = useState(() => String(initial.partner_min_bp / 100));
  const [maxPct, setMaxPct] = useState(() => String(initial.partner_max_bp / 100));
  const [reason, setReason] = useState('');

  const error = validateTierRows(rows);
  const boundsError =
    minPct.trim() === '' ||
    maxPct.trim() === '' ||
    Number.isNaN(Number(minPct)) ||
    Number.isNaN(Number(maxPct)) ||
    Number(minPct) >= Number(maxPct)
      ? 'Partner bounds must be numbers with min below max.'
      : null;

  const save = () => {
    if (error || boundsError) return;
    update.mutate(
      {
        tiers: tierRowsToPayload(rows),
        partner_min_bp: Math.round(Number(minPct) * 100),
        partner_max_bp: Math.round(Number(maxPct) * 100),
        reason: reason.trim() || 'tier table edit',
      },
      {
        onSuccess: () => {
          toast.success('Referral settings saved.');
          setReason('');
        },
        onError: (e) => toast.error(e.message),
      },
    );
  };

  return (
    <Container className="mb-4">
      <Heading level="h2">Commission tiers</Heading>
      <Text size="small" className="text-ui-fg-subtle">
        Weekly downline spend (Tue–Mon, MYT) picks the highest matching tier;
        the rate applies to the whole amount. Partners bypass this table with a
        manual rate set on their customer page.
      </Text>
      <div className="mt-4 flex flex-col gap-2">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-2">
            <Text size="small" className="text-ui-fg-muted w-14">
              Tier {i + 1}
            </Text>
            <Input
              type="number"
              value={row.minRm}
              disabled={i === 0} // the first tier always starts at RM 0
              onChange={(e) =>
                setRows(
                  rows.map((r, j) =>
                    j === i ? { ...r, minRm: e.target.value } : r,
                  ),
                )
              }
              placeholder="Min RM"
              className="w-32"
            />
            <Input
              type="number"
              value={row.ratePct}
              onChange={(e) =>
                setRows(
                  rows.map((r, j) =>
                    j === i ? { ...r, ratePct: e.target.value } : r,
                  ),
                )
              }
              placeholder="Rate %"
              className="w-24"
            />
            <Text size="small" className="text-ui-fg-muted">
              %
            </Text>
            {i > 0 && (
              <Button
                size="small"
                variant="transparent"
                onClick={() => setRows(rows.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            )}
          </div>
        ))}
        <div>
          <Button
            size="small"
            variant="secondary"
            onClick={() => setRows([...rows, { minRm: '', ratePct: '' }])}
          >
            Add tier
          </Button>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-2">
        <Text size="small" className="text-ui-fg-subtle">
          Partner rate bounds
        </Text>
        <Input
          type="number"
          value={minPct}
          onChange={(e) => setMinPct(e.target.value)}
          className="w-24"
          placeholder="Min %"
        />
        <Text size="small" className="text-ui-fg-muted">
          –
        </Text>
        <Input
          type="number"
          value={maxPct}
          onChange={(e) => setMaxPct(e.target.value)}
          className="w-24"
          placeholder="Max %"
        />
        <Text size="small" className="text-ui-fg-muted">
          %
        </Text>
      </div>
      {(error ?? boundsError) && (
        <Text size="small" className="text-ui-fg-error mt-2">
          {error ?? boundsError}
        </Text>
      )}
      <div className="mt-4 flex items-center gap-2">
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (audited)"
          className="w-64"
        />
        <Button
          size="small"
          onClick={save}
          disabled={Boolean(error ?? boundsError) || update.isPending}
        >
          Save settings
        </Button>
      </div>
    </Container>
  );
}

function LineTable({ settlementId }: { settlementId: string }) {
  const { data, isLoading } = useReferralSettlement(settlementId);
  const voidLine = useVoidReferralLine();
  const prompt = usePrompt();

  if (isLoading || !data) return <LoadingSkeleton rows={3} />;

  const onVoid = async (lineId: string) => {
    const reason = window.prompt('Void reason (audited):')?.trim();
    if (!reason) return;
    const confirmed = await prompt({
      title: 'Void this line?',
      description:
        'The customer will not be paid for this line. This cannot be undone.',
      confirmText: 'Void line',
    });
    if (!confirmed) return;
    voidLine.mutate(
      { lineId, reason },
      {
        onSuccess: () => toast.success('Line voided.'),
        onError: (e) => toast.error(e.message),
      },
    );
  };

  const payable =
    data.settlement.status === 'draft' || data.settlement.status === 'approved';

  return (
    <Table>
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>Customer</Table.HeaderCell>
          <Table.HeaderCell>Kind</Table.HeaderCell>
          <Table.HeaderCell className="text-right">Basis</Table.HeaderCell>
          <Table.HeaderCell className="text-right">Rate</Table.HeaderCell>
          <Table.HeaderCell className="text-right">Payout</Table.HeaderCell>
          <Table.HeaderCell>Status</Table.HeaderCell>
          <Table.HeaderCell />
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {data.lines.map((l) => (
          <Table.Row key={l.id}>
            <Table.Cell className="font-mono text-xs">
              {l.customer_id}
            </Table.Cell>
            <Table.Cell>
              {l.kind === 'referral_commission' ? 'Commission' : 'VIP rebate'}
            </Table.Cell>
            <Table.Cell className="text-right">
              {fromCents(l.basis_cents)}
            </Table.Cell>
            <Table.Cell className="text-right">
              {pctLabel(l.rate_bp)}
            </Table.Cell>
            <Table.Cell className="text-right">
              {fromCents(l.amount_cents)}
            </Table.Cell>
            <Table.Cell>
              <Badge
                size="2xsmall"
                color={
                  l.status === 'paid'
                    ? 'green'
                    : l.status === 'voided'
                      ? 'red'
                      : 'orange'
                }
              >
                {l.status}
              </Badge>
              {l.void_reason && (
                <Text size="xsmall" className="text-ui-fg-muted">
                  {l.void_reason}
                </Text>
              )}
            </Table.Cell>
            <Table.Cell>
              {payable && l.status === 'pending' && (
                <Button
                  size="small"
                  variant="transparent"
                  onClick={() => void onVoid(l.id)}
                >
                  Void
                </Button>
              )}
            </Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
}

function RunsCard() {
  const { data, isLoading } = useReferralSettlements();
  const approve = useApproveReferralSettlement();
  const pay = usePayReferralSettlement();
  const prompt = usePrompt();
  const [openId, setOpenId] = useState<string | null>(null);

  if (isLoading || !data) return <LoadingSkeleton rows={4} />;

  const onApprove = async (run: ReferralSettlement) => {
    const confirmed = await prompt({
      title: `Approve week ${run.week_start}?`,
      description: `${fromCents(run.total_commission_cents)} commission + ${fromCents(run.total_rebate_cents)} rebate will pay out on the next Wednesday run (or via Pay now).`,
      confirmText: 'Approve',
    });
    if (!confirmed) return;
    approve.mutate(run.id, {
      onSuccess: () => toast.success('Settlement approved.'),
      onError: (e) => toast.error(e.message),
    });
  };

  const onPay = async (run: ReferralSettlement) => {
    const confirmed = await prompt({
      title: `Pay week ${run.week_start} now?`,
      description:
        'Every pending line is credited immediately. The Wednesday cron would do the same — this just does it now.',
      confirmText: 'Pay now',
    });
    if (!confirmed) return;
    pay.mutate(run.id, {
      onSuccess: (r) =>
        toast.success(`Paid ${r.paid} line(s), skipped ${r.skipped}.`),
      onError: (e) => toast.error(e.message),
    });
  };

  return (
    <Container>
      <Heading level="h2">Weekly settlements</Heading>
      <Text size="small" className="text-ui-fg-subtle">
        Tuesday's close lands here as a draft. Review the lines, void anything
        suspicious, then Approve — Wednesday's cron (or Pay now) moves the
        money.
      </Text>
      {data.length === 0 ? (
        <Text size="small" className="text-ui-fg-muted mt-4">
          No settlement runs yet — the first Tuesday close will create one.
        </Text>
      ) : (
        <Table className="mt-4">
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Week (Tue)</Table.HeaderCell>
              <Table.HeaderCell>Status</Table.HeaderCell>
              <Table.HeaderCell className="text-right">
                Commission
              </Table.HeaderCell>
              <Table.HeaderCell className="text-right">Rebate</Table.HeaderCell>
              <Table.HeaderCell />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {data.map((run) => (
              <>
                <Table.Row key={run.id}>
                  <Table.Cell>{run.week_start}</Table.Cell>
                  <Table.Cell>
                    <Badge size="2xsmall" color={STATUS_COLOR[run.status]}>
                      {run.status}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell className="text-right">
                    {fromCents(run.total_commission_cents)}
                  </Table.Cell>
                  <Table.Cell className="text-right">
                    {fromCents(run.total_rebate_cents)}
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex justify-end gap-2">
                      <Button
                        size="small"
                        variant="transparent"
                        onClick={() =>
                          setOpenId(openId === run.id ? null : run.id)
                        }
                      >
                        {openId === run.id ? 'Hide lines' : 'Review lines'}
                      </Button>
                      {run.status === 'draft' && (
                        <Button
                          size="small"
                          onClick={() => void onApprove(run)}
                          disabled={approve.isPending}
                        >
                          Approve
                        </Button>
                      )}
                      {run.status === 'approved' && (
                        <Button
                          size="small"
                          onClick={() => void onPay(run)}
                          disabled={pay.isPending}
                        >
                          Pay now
                        </Button>
                      )}
                    </div>
                  </Table.Cell>
                </Table.Row>
                {openId === run.id && (
                  <Table.Row key={`${run.id}-detail`}>
                    {/* @medusajs/ui's Cell type omits colSpan — span via the
                        native attribute through props spread instead. */}
                    <Table.Cell {...{ colSpan: 5 }}>
                      <LineTable settlementId={run.id} />
                    </Table.Cell>
                  </Table.Row>
                )}
              </>
            ))}
          </Table.Body>
        </Table>
      )}
    </Container>
  );
}

const ReferralsPage = () => (
  <div className="flex flex-col gap-4">
    <SettingsCard />
    <RunsCard />
  </div>
);

export default ReferralsPage;
