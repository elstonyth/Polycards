import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Container, Text } from '@medusajs/ui';
import { usePurchaseInvoice } from '../../../../lib/queries';
import { httpStatus } from '../../../../lib/admin-rest';
import { LoadingSkeleton } from '../../../../components/LoadingSkeleton';
import { PurchaseInvoiceForm } from '../../invoice-form';

// ponytail: no config export — reached from the invoice page's Edit button.

// A reversal, or an invoice already reversed, is not edited here; the server
// refuses both under the invoice's lock either way, this just says so before
// anyone types.
const EditPurchaseInvoicePage = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const { data, isError, error } = usePurchaseInvoice(id ?? null);
  const inv = data?.invoice;

  // key: another invoice, or this one saved by someone else, starts a fresh
  // form rather than keeping the old draft (a plain refetch keeps the typing).
  if (inv && !inv.reverses_invoice_id && !inv.reversed_by)
    return (
      <PurchaseInvoiceForm key={`${inv.id}:${inv.updated_at}`} editing={inv} />
    );
  if (!inv && !isError) return <LoadingSkeleton />;
  return (
    <Container className="flex flex-col items-start gap-y-2 px-6 py-4">
      <Text className="text-ui-fg-subtle">
        {!inv
          ? httpStatus(error) === 404
            ? t('pi.notFound')
            : t('pi.loadError')
          : inv.reversed_by
            ? t('pi.notEditableReversed', {
                no: inv.display_no,
                by: inv.reversed_by.display_no,
              })
            : t('pi.notEditableReversal', { no: inv.display_no })}
      </Text>
      <Link
        to={inv ? `/purchase-invoices/${inv.id}` : '/purchase-invoices'}
        className="text-ui-fg-interactive text-sm hover:underline"
      >
        {inv ? inv.display_no : 'Purchase invoices'}
      </Link>
    </Container>
  );
};

export default EditPurchaseInvoicePage;
