import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Container, Table, Text } from '@medusajs/ui';
import { useMoneyIntegrity } from '../../lib/queries';
import { rm } from '../../lib/format';

/**
 * Money a crash left half-moved (GET /admin/payments/integrity). Not per
 * currency: the ledger is RM. Renders nothing while the list is empty.
 */
export const IntegrityFindings = () => {
  const { t } = useTranslation();
  const findings = useMoneyIntegrity().data?.findings ?? [];
  if (findings.length === 0) return null;

  return (
    <Container className="p-0" data-testid="integrity-card">
      <div className="bg-ui-tag-orange-bg px-6 py-3">
        <Text size="small" weight="plus">
          {t('settlement.integrityBar', { count: findings.length })}
        </Text>
        <Text size="xsmall" className="text-ui-fg-subtle">
          {t('settlement.integrityHint')}
        </Text>
      </div>
      <div className="overflow-x-auto border-t">
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t('settlement.auditNote')}</Table.HeaderCell>
              <Table.HeaderCell>
                {t('settlement.auditCustomer')}
              </Table.HeaderCell>
              <Table.HeaderCell className="text-right">
                {t('settlement.auditAmount')}
              </Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {findings.map((f) => (
              <Table.Row key={`${f.kind}-${f.id}`}>
                <Table.Cell className="text-ui-fg-error">
                  {t(`settlement.integrity.${f.kind}`)}
                  <Text
                    as="span"
                    size="xsmall"
                    className="text-ui-fg-subtle block break-all font-mono"
                  >
                    {f.id} · {new Date(f.at).toLocaleString('en-MY')}
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
                <Table.Cell className="text-right tabular-nums">
                  {rm(f.amount)}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>
    </Container>
  );
};
