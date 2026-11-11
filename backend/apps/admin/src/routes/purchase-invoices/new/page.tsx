import { PurchaseInvoiceForm } from '../invoice-form';

// ponytail: no config export — a create page belongs behind the list's "New
// invoice" button, not in the sidebar (mirrors [id]/page.tsx).
const NewPurchaseInvoicePage = () => <PurchaseInvoiceForm />;

export default NewPurchaseInvoicePage;
