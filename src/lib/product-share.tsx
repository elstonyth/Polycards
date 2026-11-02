import { SITE_URL } from '@/lib/site';

export const SHARE_IMAGE_SIDE = 1080;

/** The Open Graph entry for a page with a share.jpg route under its path. */
export const shareImageMeta = (path: string, alt: string) => ({
  url: `${path}/share.jpg`,
  width: SHARE_IMAGE_SIDE,
  height: SHARE_IMAGE_SIDE,
  type: 'image/jpeg',
  alt,
});

/**
 * Tells Meta's catalog which picture is the product, so it stops guessing from
 * the page's <img>s. No price: cards are pulled, not sold, and Meta would print
 * it on ad tiles.
 */
export function ProductJsonLd({
  name,
  description,
  sku,
  path,
}: {
  name: string;
  description: string;
  sku: string;
  path: string;
}) {
  const product = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name,
    description,
    sku,
    brand: { '@type': 'Brand', name: 'Polycards' },
    url: `${SITE_URL}${path}`,
    image: `${SITE_URL}${path}/share.jpg`,
  };
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(product).replace(/</g, '\\u003c'),
      }}
    />
  );
}
