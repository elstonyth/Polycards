import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'PixelSlot — Physical & Digital Collectibles',
    short_name: 'PixelSlot',
    description:
      'Rip packs. Pull graded cards. Hold, trade, redeem, or sell back at up to 90% value.',
    start_url: '/',
    display: 'standalone',
    background_color: '#171717',
    theme_color: '#171717',
    icons: [
      { src: '/seo/icon-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: '/seo/icon-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
