import type { Permission } from '@mercurjs/dashboard-sdk';
import { usePermissions } from '@mercurjs/admin';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  Button,
  Container,
  Label,
  Prompt,
  StatusBadge,
  Table,
  Text,
  Textarea,
} from '@medusajs/ui';
import type { GatewayAuditFinding } from '../../lib/admin-rest';
import { useAcknowledgeFinding, useGatewayAudit } from '../../lib/queries';
import { rm } from '../../lib/format';
import { paymentStatus } from '../../lib/dashboard';
import { auditCounts } from './audit-counts';

// The first few are enough to act on; the rest are one click away.
const SHOWN = 10;

/**
 * Gateway audit findings (plan 130) for one currency — only when the hourly
 * audit disagrees with our rows. When everything matches, the "Gateway check"
 * tile at the top of the tab says so and this renders nothing.
 */
export const AuditFindings = ({ currency }: { currency: string }) => {
  const { t } = useTranslation();
  // Writes here ask payment:update; a view-only role reads the figures only.
  const canEdit = usePermissions().hasPermission(
    'payment:update' as Permission,
  );
  const audit = useGatewayAudit(currency);
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  // The finding the Acknowledge prompt is about, and the reason being typed.
  const [target, setTarget] = useState<GatewayAuditFinding | null>(null);
  const [reason, setReason] = useState('');
  const acknowledge = useAcknowledgeFinding();
  const a = audit.data;
  if (!a) return null;
  const n = auditCounts(a);
  if (!n.show) return null;
  const capped = n.capped;

  return (
    <Container className="p-0" data-testid={`audit-card-${currency}`}>
      <div
        className={`${n.differ > 0 ? 'bg-ui-tag-orange-bg' : 'bg-ui-bg-subtle'} flex flex-wrap items-center justify-between gap-3 px-6 py-3`}
      >
        <Text size="small">
          {n.differ > 0 ? (
            <Text as="span" size="small" weight="plus">
              {t('settlement.findingsBar', { count: n.differ })}
            </Text>
          ) : null}
          {n.acknowledged > 0 ? (
            <Text as="span" size="small" className="text-ui-fg-subtle">
              {n.differ > 0 ? ' · ' : ''}
              {t('settlement.acknowledgedFindings', { count: n.acknowledged })}
            </Text>
          ) : null}
          {n.retired > 0 ? (
            <Text as="span" size="small" className="text-ui-fg-subtle">
              {n.differ + n.acknowledged > 0 ? ' · ' : ''}
              {t('settlement.retiredFindings', { count: n.retired })}
            </Text>
          ) : null}
          {a.last_audited_at ? (
            <Text as="span" size="small" className="text-ui-fg-subtle">
              {' · '}
              {t('settlement.auditLastRun', {
                when: new Date(a.last_audited_at).toLocaleString('en-MY'),
              })}
            </Text>
          ) : null}
        </Text>
        <Button
          size="small"
          variant="transparent"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? t('settlement.hideList') : t('settlement.showList')}
        </Button>
      </div>
      {open && a.findings.length > 0 ? (
        <div className="overflow-x-auto border-t">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>{t('settlement.payment')}</Table.HeaderCell>
                <Table.HeaderCell>
                  {t('settlement.auditCustomer')}
                </Table.HeaderCell>
                <Table.HeaderCell>
                  {t('settlement.auditStatus')}
                </Table.HeaderCell>
                <Table.HeaderCell className="text-right">
                  {t('settlement.auditAmount')}
                </Table.HeaderCell>
                <Table.HeaderCell>{t('settlement.auditNote')}</Table.HeaderCell>
                <Table.HeaderCell>
                  <span className="sr-only">{t('settlement.ackAction')}</span>
                </Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {(all ? a.findings : a.findings.slice(0, SHOWN)).map((f) => {
                const ref =
                  f.gateway_transaction_id ?? f.merchant_transaction_id;
                const kind = f.kind === 'withdrawal' ? 'withdrawal' : 'deposit';
                const s = paymentStatus(kind, f.status);
                const acked = f.acknowledged;
                return (
                  <Table.Row
                    key={`${f.kind}-${f.id}`}
                    className={acked ? 'opacity-60' : undefined}
                  >
                    <Table.Cell>
                      {t(`settlement.kind.${kind}`)}
                      <Text
                        as="span"
                        size="xsmall"
                        className="text-ui-fg-subtle block break-all font-mono"
                      >
                        {ref} · {f.gateway}
                      </Text>
                    </Table.Cell>
                    <Table.Cell className="font-mono text-xs">
                      <Link
                        to={`/customers/${f.customer_id}`}
                        className="text-ui-fg-interactive hover:text-ui-fg-interactive-hover"
                      >
                        {f.customer_id}
                      </Link>
                    </Table.Cell>
                    <Table.Cell>
                      <StatusBadge color={s.color}>{t(s.labelKey)}</StatusBadge>
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {f.amount === null ? '—' : rm(f.amount)}
                    </Table.Cell>
                    <Table.Cell
                      className={
                        acked ? 'text-ui-fg-subtle' : 'text-ui-fg-error'
                      }
                    >
                      {f.note}
                      {acked ? (
                        <Text
                          as="span"
                          size="xsmall"
                          className="text-ui-fg-muted block"
                        >
                          {t('settlement.acknowledgedBy', {
                            who: acked.by ?? '—',
                            when: acked.at
                              ? new Date(acked.at).toLocaleString('en-MY')
                              : '—',
                          })}
                          {acked.reason ? ` · “${acked.reason}”` : ''}
                        </Text>
                      ) : null}
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      {acked || !canEdit ? null : (
                        <Button
                          size="small"
                          variant="secondary"
                          onClick={() => {
                            setReason('');
                            setTarget(f);
                          }}
                        >
                          {t('settlement.acknowledge')}
                        </Button>
                      )}
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
          {!all && a.findings.length > SHOWN ? (
            <div className="border-t px-6 py-2">
              <Button
                size="small"
                variant="transparent"
                onClick={() => setAll(true)}
              >
                {capped
                  ? t('settlement.showFirstFindings', {
                      count: a.findings.length,
                      total: n.all,
                    })
                  : t('settlement.showAllFindings', {
                      count: a.findings.length,
                    })}
              </Button>
            </div>
          ) : all && capped ? (
            <Text
              size="xsmall"
              className="text-ui-fg-subtle border-t px-6 py-3"
            >
              {t('settlement.findingsCapped', {
                count: a.findings.length,
                total: n.all,
              })}
            </Text>
          ) : null}
        </div>
      ) : null}

      {/* The reason is required and goes to the admin action log. The note
          sent is the one on screen: if the hourly check re-worded it since,
          the backend refuses (409) instead of acknowledging it unseen. */}
      <Prompt
        variant="confirmation"
        open={target !== null}
        onOpenChange={(o) => {
          if (!o) setTarget(null);
        }}
      >
        <Prompt.Content>
          <Prompt.Header>
            <Prompt.Title>{t('settlement.ackTitle')}</Prompt.Title>
            <Prompt.Description>{t('settlement.ackDesc')}</Prompt.Description>
          </Prompt.Header>
          <div className="flex flex-col gap-1 px-6 pb-2">
            <Text size="small" className="text-ui-fg-subtle">
              {target?.note}
            </Text>
            <Label htmlFor="ack-reason" size="small" className="mt-2">
              {t('settlement.ackReason')}
            </Label>
            <Textarea
              id="ack-reason"
              maxLength={500}
              value={reason}
              placeholder={t('settlement.ackReasonPlaceholder')}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
            />
          </div>
          <Prompt.Footer>
            <Prompt.Cancel>{t('settlement.ackCancel')}</Prompt.Cancel>
            <Prompt.Action
              disabled={!reason.trim() || acknowledge.isPending}
              onClick={() => {
                if (!target || !reason.trim()) return;
                acknowledge.mutate({
                  kind: target.kind,
                  id: target.id,
                  note: target.note,
                  reason: reason.trim(),
                });
                setTarget(null);
              }}
            >
              {t('settlement.acknowledge')}
            </Prompt.Action>
          </Prompt.Footer>
        </Prompt.Content>
      </Prompt>
    </Container>
  );
};
