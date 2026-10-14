import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Container, StatusBadge, Table, Text } from '@medusajs/ui';
import { useGatewayAudit } from '../../lib/queries';
import { rm } from '../../lib/format';
import { paymentStatus } from '../../lib/dashboard';

// 'abcdef1234567890' → 'abcdef12…567890': enough to match by eye against the
// gateway's back office; the full reference is in the title.
// The first few are enough to act on; the rest are one click away.
const SHOWN = 10;

const shortRef = (ref: string) =>
  ref.length > 16 ? `${ref.slice(0, 8)}…${ref.slice(-6)}` : ref;

/**
 * Gateway audit findings (plan 130) for one currency — only when the hourly
 * audit disagrees with our rows. When everything matches, the "Gateway check"
 * tile at the top of the tab says so and this renders nothing.
 */
export const AuditFindings = ({ currency }: { currency: string }) => {
  const { t } = useTranslation();
  const audit = useGatewayAudit(currency);
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const a = audit.data;
  if (!a || a.findings_total === 0) return null;

  return (
    <Container className="p-0" data-testid={`audit-card-${currency}`}>
      <div className="bg-ui-tag-orange-bg flex flex-wrap items-center justify-between gap-3 px-6 py-3">
        <Text size="small">
          <Text as="span" size="small" weight="plus">
            {t('settlement.findingsBar', { count: a.findings_total })}
          </Text>
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
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {(all ? a.findings : a.findings.slice(0, SHOWN)).map((f) => {
                const ref =
                  f.gateway_transaction_id ?? f.merchant_transaction_id;
                const kind = f.kind === 'withdrawal' ? 'withdrawal' : 'deposit';
                const s = paymentStatus(kind, f.status);
                return (
                  <Table.Row key={`${f.kind}-${f.id}`}>
                    <Table.Cell>
                      {t(`settlement.kind.${kind}`)}
                      <Text
                        as="span"
                        size="xsmall"
                        className="text-ui-fg-muted block font-mono"
                        title={ref}
                      >
                        {shortRef(ref)} · {f.gateway}
                      </Text>
                    </Table.Cell>
                    <Table.Cell className="font-mono text-xs">
                      {f.customer_id}
                    </Table.Cell>
                    <Table.Cell>
                      <StatusBadge color={s.color}>{t(s.labelKey)}</StatusBadge>
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {f.amount === null ? '—' : rm(f.amount)}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-error">
                      {f.note}
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
          {!all && a.findings.length > SHOWN ? (
            <div className="border-t px-6 py-2">
              <Button size="small" variant="transparent" onClick={() => setAll(true)}>
                {t('settlement.showAllFindings', { count: a.findings.length })}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Container>
  );
};
