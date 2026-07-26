import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import { Button } from '@medusajs/ui';
import { useDeliveryOrder } from '../../../lib/queries';
import { DELIVERY_STATUS_LABEL, orderDateTime } from '../../../lib/format';
import { resolveImageUrl } from '../../../lib/image-url';
import { parsePrintIds, PRINT_ID_CAP } from './ids';

// NO `config` export on purpose: this is a packing slip reached from the All
// Orders bulk bar, not a destination, so it stays out of the sidebar nav.

// Rendered through a portal into <body> and styled by plain CSS rather than the
// dashboard's Tailwind/dark tokens, for two reasons:
//   1. Printing must emit ONLY the slips. The dashboard shell wraps every route,
//      and the usual `visibility: hidden` trick leaves the slips inside the
//      shell's scroll container — an ancestor `overflow` CLIPS an absolutely
//      positioned descendant in print output, so only the first screenful
//      reaches the paper. A body-level sibling has no such ancestor.
//   2. A packing slip is ink on white, not a themed surface: hardcoded #fff/#000
//      survives a dark-mode dashboard and a browser set to "no background
//      graphics" alike.
// On screen the sheet is a fixed overlay covering the shell; @media print drops
// it back into normal flow so the browser paginates it.
const PRINT_CSS = `
@page { margin: 12mm; }
#op-print {
  position: fixed;
  inset: 0;
  z-index: 60;
  overflow: auto;
  padding: 24px;
  background: #fff;
  color: #000;
  font: 13px/1.45 ui-sans-serif, system-ui, sans-serif;
}
#op-print h1 { font-size: 18px; font-weight: 700; margin: 0; }
#op-print p { margin: 0; }
.op-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
.op-order {
  border: 1px solid #000;
  padding: 16px;
  margin-bottom: 16px;
  break-inside: avoid;
  page-break-inside: avoid;
}
.op-order h2 { font-size: 15px; font-weight: 700; margin: 0; }
.op-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.op-cols { display: flex; flex-wrap: wrap; gap: 32px; margin-bottom: 12px; }
.op-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  margin-bottom: 3px;
  text-align: left;
}
.op-label-gap { margin-top: 12px; }
.op-mono { font-family: ui-monospace, monospace; font-size: 11px; }
.op-items { width: 100%; border-collapse: collapse; }
.op-items th, .op-items td {
  border-top: 1px solid #000;
  padding: 5px 4px;
  text-align: left;
  vertical-align: middle;
}
.op-items th { font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; }
.op-items img { display: block; width: 34px; height: 48px; object-fit: contain; }
@media print {
  .no-print { display: none }
  #op-print { position: static; overflow: visible; padding: 0; }
  body > *:not(#op-print) { display: none !important; }
  /* A scroll container anywhere above the sheet clips it to a single page.
     The shell sets no such rule today; this keeps that true if it ever does. */
  html, body { overflow: visible !important; height: auto !important; }
}
`;

const Slip = ({ id }: { id: string }) => {
  const { data: order, error } = useDeliveryOrder(id);

  // Every slip resolves independently: one deleted/mistyped id 404s in its own
  // block, and the rest of the run still prints.
  if (error) {
    return (
      <section className="op-order">
        <h2>Order #{id.slice(-6)}</h2>
        <p className="op-mono">{id}</p>
        <p>Could not load this order: {error.message}</p>
      </section>
    );
  }
  if (!order) {
    return (
      <section className="op-order" aria-busy="true">
        <h2>Order #{id.slice(-6)}</h2>
        <p className="op-mono">{id}</p>
        <p>Loading…</p>
      </section>
    );
  }

  const a = order.address;
  return (
    <section className="op-order">
      <div className="op-head">
        <div>
          <h2>Order #{order.id.slice(-6)}</h2>
          <p className="op-mono">{order.id}</p>
        </div>
        <div>
          <p>{orderDateTime(order.created_at)}</p>
          <p>{DELIVERY_STATUS_LABEL[order.status]}</p>
        </div>
      </div>

      <div className="op-cols">
        <div>
          <p className="op-label">Ship to</p>
          <p>{a.name}</p>
          <p>{a.address_1}</p>
          {a.address_2 && <p>{a.address_2}</p>}
          <p>{[a.city, a.province, a.postal_code].filter(Boolean).join(' ')}</p>
          <p>{a.country_code.toUpperCase()}</p>
          {a.phone && <p>Tel: {a.phone}</p>}
        </div>
        <div>
          <p className="op-label">Customer</p>
          <p>{order.customer_email ?? order.customer_id}</p>
          <p className="op-label op-label-gap">Tracking number</p>
          <p>{order.tracking_number ?? '—'}</p>
        </div>
      </div>

      <table className="op-items">
        <caption className="op-label">
          {order.items.length} item{order.items.length === 1 ? '' : 's'}
        </caption>
        <thead>
          <tr>
            <th scope="col">Card</th>
            <th scope="col">Name</th>
            <th scope="col">Handle</th>
            <th scope="col">Qty</th>
          </tr>
        </thead>
        <tbody>
          {order.items.map((it) => (
            <tr key={it.pull_id}>
              <td>
                {it.card && (
                  // No loading="lazy" here (unlike the All Orders table): a
                  // below-the-fold image that has not loaded prints blank.
                  <img
                    src={resolveImageUrl(it.card.slab_image || it.card.image)}
                    alt=""
                    decoding="async"
                  />
                )}
              </td>
              <td>{it.card?.name ?? 'Unknown card'}</td>
              <td className="op-mono">{it.card?.handle ?? it.pull_id}</td>
              {/* One row per pull, and a pull is a single graded card. */}
              <td>1</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
};

const DeliveryPrintPage = () => {
  const [searchParams] = useSearchParams();
  const ids = parsePrintIds(searchParams.get('ids'));
  const overCap = ids.length > PRINT_ID_CAP;

  return createPortal(
    <div id="op-print">
      <style>{PRINT_CSS}</style>
      <div className="op-bar no-print">
        <h1>Packing slips</h1>
        <Button size="small" onClick={() => window.print()} disabled={overCap}>
          Print
        </Button>
        <p>
          {overCap
            ? `${ids.length} orders selected`
            : `${ids.length} order${ids.length === 1 ? '' : 's'}`}
        </p>
        {/* The sheet is a full-screen overlay, so the sidebar is unreachable
            behind it — needed when this is opened in the current tab (browser
            back/forward) rather than the bulk bar's new one. */}
        <Link to="/deliveries">Back to All Orders</Link>
      </div>

      {overCap ? (
        // Bail BEFORE mounting any slip, so an over-cap URL fires no requests.
        <p>
          Too many orders to print at once: {ids.length} selected, {PRINT_ID_CAP}{' '}
          is the maximum. Print them in smaller batches.
        </p>
      ) : ids.length === 0 ? (
        <p>No orders selected. Pick orders on All Orders and choose Print.</p>
      ) : (
        ids.map((id) => <Slip key={id} id={id} />)
      )}
    </div>,
    document.body,
  );
};

export default DeliveryPrintPage;
