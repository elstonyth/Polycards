import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  Badge,
  Button,
  Checkbox,
  Drawer,
  Heading,
  Label,
  StatusBadge,
  Table,
  Text,
} from '@medusajs/ui';
import { useQuery } from '@tanstack/react-query';
import {
  getWithdrawalLinks,
  type GatewayWithdrawal,
  type WithdrawalLinkedAccount,
  type WithdrawalLinks,
} from '../../lib/admin-rest';
import { qk } from '../../lib/query-keys';
import { rm } from '../../lib/format';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

const name = (a: { handle: string | null; username: string | null }) =>
  a.handle ?? a.username ?? '—';
const day = (iso: string) => iso.slice(0, 10);

const Section = ({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) => (
  <section className="flex flex-col gap-y-2">
    <Heading level="h3">{title}</Heading>
    {children}
  </section>
);

/** The ticks for one linked account: why it is on this screen. */
const LinkBadges = ({ a }: { a: WithdrawalLinkedAccount }) => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1">
      {a.same_browser && (
        <Badge size="2xsmall" color={a.household_verified ? 'green' : 'orange'}>
          {a.household_verified
            ? t('withdrawals.review.householdVerified')
            : t('withdrawals.review.sameBrowser')}
        </Badge>
      )}
      {a.same_network && (
        <Badge size="2xsmall">{t('withdrawals.review.sameNetwork')}</Badge>
      )}
      {a.invited_this_account && (
        <Badge size="2xsmall">{t('withdrawals.review.invitedThis')}</Badge>
      )}
      {a.invited_by_this_account && (
        <Badge size="2xsmall">{t('withdrawals.review.invitedByThis')}</Badge>
      )}
    </div>
  );
};

const AccountState = ({ a }: { a: { banned: boolean; disabled: boolean } }) => {
  const { t } = useTranslation();
  if (a.banned)
    return (
      <StatusBadge color="red">{t('withdrawals.review.banned')}</StatusBadge>
    );
  if (a.disabled)
    return (
      <StatusBadge color="orange">
        {t('withdrawals.review.disabled')}
      </StatusBadge>
    );
  return (
    <StatusBadge color="green">{t('withdrawals.review.open')}</StatusBadge>
  );
};

const Body = ({ links }: { links: WithdrawalLinks }) => {
  const { t } = useTranslation();
  const w = links.withdrawal;
  const me = links.account;
  return (
    <div className="flex flex-col gap-y-6">
      <Section title={t('withdrawals.review.withdrawal')}>
        <Text size="small">
          {rm(w.amount)} · {w.bank_name} ••{w.last4} · {w.holder_name}
        </Text>
        <div>
          <StatusBadge
            color={w.hold_reason === 'shared_device' ? 'orange' : 'grey'}
          >
            {w.hold_reason === 'shared_device'
              ? t('withdrawals.holdShared')
              : t('withdrawals.holdAmount')}
          </StatusBadge>
        </div>
      </Section>

      {me && (
        <Section title={t('withdrawals.review.account')}>
          <div className="flex items-center gap-x-2">
            <Link
              className="text-ui-fg-interactive hover:underline"
              to={`/customers/${me.id}`}
            >
              {name(me)}
            </Link>
            <AccountState a={me} />
            <Text size="small" className="text-ui-fg-muted">
              {t('withdrawals.review.joined', { date: day(me.created_at) })}
            </Text>
          </div>
          <Text size="small">
            {t('withdrawals.review.money', {
              topups: rm(me.topups),
              withdrawn: rm(me.withdrawn),
              prize: rm(me.prize_sales),
              balance: rm(me.balance),
            })}
          </Text>
        </Section>
      )}

      <Section
        title={t('withdrawals.review.linked', { n: links.linked.length })}
      >
        {links.linked.length === 0 ? (
          <Text size="small" className="text-ui-fg-muted">
            {t('withdrawals.review.noLinked')}
          </Text>
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>
                  {t('withdrawals.review.col.account')}
                </Table.HeaderCell>
                <Table.HeaderCell>
                  {t('withdrawals.review.col.why')}
                </Table.HeaderCell>
                <Table.HeaderCell>
                  {t('withdrawals.review.col.topups')}
                </Table.HeaderCell>
                <Table.HeaderCell>
                  {t('withdrawals.review.col.withdrawn')}
                </Table.HeaderCell>
                <Table.HeaderCell>
                  {t('withdrawals.review.col.prize')}
                </Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {links.linked.map((a) => (
                <Table.Row key={a.id}>
                  <Table.Cell>
                    <div className="flex flex-col gap-y-1 py-1">
                      <Link
                        className="text-ui-fg-interactive hover:underline"
                        to={`/customers/${a.id}`}
                      >
                        {name(a)}
                      </Link>
                      <div className="flex items-center gap-x-1">
                        <AccountState a={a} />
                        <Text size="xsmall" className="text-ui-fg-muted">
                          {day(a.created_at)}
                        </Text>
                      </div>
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <LinkBadges a={a} />
                  </Table.Cell>
                  <Table.Cell>{rm(a.topups)}</Table.Cell>
                  <Table.Cell>{rm(a.withdrawn)}</Table.Cell>
                  <Table.Cell>{rm(a.prize_sales)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
        {links.networks_shared > 0 && (
          <Text size="xsmall" className="text-ui-fg-muted">
            {t('withdrawals.review.networks', { n: links.networks_shared })}
          </Text>
        )}
      </Section>

      <Section title={t('withdrawals.review.banks')}>
        {links.bank_accounts.length === 0 ? (
          <Text size="small" className="text-ui-fg-muted">
            {t('withdrawals.review.noBanks')}
          </Text>
        ) : (
          links.bank_accounts.map((b) => (
            <div key={`${b.bank}-${b.last4}`} className="flex flex-col gap-y-1">
              <div className="flex items-center gap-x-2">
                <Text size="small" weight="plus">
                  {b.bank} ••{b.last4}
                </Text>
                {b.banned_number && (
                  <StatusBadge color="red">
                    {t('withdrawals.review.bannedNumber')}
                  </StatusBadge>
                )}
                <Text size="xsmall" className="text-ui-fg-muted">
                  {t('withdrawals.review.paidHere', {
                    amount: rm(b.this_player_payouts.rm),
                  })}
                </Text>
              </div>
              {b.other_accounts.length === 0 ? (
                <Text size="xsmall" className="text-ui-fg-muted">
                  {t('withdrawals.review.onlyThis')}
                </Text>
              ) : (
                <ul className="ml-4 list-disc">
                  {b.other_accounts.map((o, i) => (
                    <li key={`${o.handle ?? o.username ?? 'x'}-${i}`}>
                      <Text size="xsmall">
                        {t('withdrawals.review.otherOnBank', {
                          who: name(o),
                          paid: rm(o.payouts.rm),
                        })}
                        {o.same_holder_name === true &&
                          ` · ${t('withdrawals.review.sameHolder')}`}
                        {o.banned && ` · ${t('withdrawals.review.banned')}`}
                      </Text>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))
        )}
      </Section>

      {links.same_name_accounts.length > 0 && (
        <Section title={t('withdrawals.review.sameName')}>
          <ul className="ml-4 list-disc">
            {links.same_name_accounts.map((s, i) => (
              <li key={`${s.handle ?? s.username ?? 'x'}-${i}`}>
                <Text size="xsmall">
                  {name(s)}
                  {s.banks.length > 0 &&
                    ` · ${s.banks.map((b) => `${b.bank} ••${b.last4}`).join(', ')}`}
                  {s.cleared_as_different_person &&
                    ` · ${t('withdrawals.review.differentPerson')}`}
                  {s.banned && ` · ${t('withdrawals.review.banned')}`}
                </Text>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
};

/** The one-screen review of a held withdrawal (ADR 0018): who else shares its
 *  browser or network, invited it or was invited by it; every bank it used and
 *  who else used them; the money; then Approve or Deny in the same panel.
 *  Opening it is an audited reveal, so it fetches only while open. */
export const WithdrawalReviewDrawer = ({
  withdrawal,
  open,
  onOpenChange,
  canDecide,
  busy,
  onApprove,
  onDeny,
}: {
  withdrawal: GatewayWithdrawal;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canDecide: boolean;
  busy: boolean;
  onApprove: (verifyDevicePeers: boolean) => void;
  onDeny: () => void;
}) => {
  const { t } = useTranslation();
  const [household, setHousehold] = useState(false);
  const { data: links, isError } = useQuery({
    queryKey: qk.withdrawalLinks(withdrawal.id),
    queryFn: () => getWithdrawalLinks(withdrawal.id),
    enabled: open,
    staleTime: Infinity,
  });
  const canVerify = (links?.unverified_peers ?? 0) > 0;
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <Drawer.Content className="max-w-2xl">
        <Drawer.Header>
          <Drawer.Title>{t('withdrawals.review.title')}</Drawer.Title>
        </Drawer.Header>
        <Drawer.Body className="overflow-y-auto">
          {isError ? (
            <Text className="text-ui-fg-error">
              {t('withdrawals.review.loadError')}
            </Text>
          ) : links ? (
            <Body links={links} />
          ) : (
            <LoadingSkeleton />
          )}
        </Drawer.Body>
        {canDecide && withdrawal.status === 'held' && (
          <Drawer.Footer className="flex flex-col items-stretch gap-y-3">
            {canVerify && (
              <div className="flex items-start gap-x-2">
                <Checkbox
                  id="review-household"
                  checked={household}
                  onCheckedChange={(v) => setHousehold(v === true)}
                />
                <Label htmlFor="review-household" size="small">
                  {t('withdrawals.review.markHousehold')}
                </Label>
              </div>
            )}
            <div className="flex justify-end gap-x-2">
              <Button
                variant="danger"
                size="small"
                disabled={busy}
                onClick={onDeny}
              >
                {t('withdrawals.deny')}
              </Button>
              <Button
                variant="primary"
                size="small"
                disabled={busy || withdrawal.frozen}
                onClick={() => onApprove(canVerify && household)}
              >
                {t('withdrawals.approve')}
              </Button>
            </div>
          </Drawer.Footer>
        )}
      </Drawer.Content>
    </Drawer>
  );
};
