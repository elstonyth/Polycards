import type { MetadataRoute } from 'next';
import { BUYBACK_RATE_LABEL } from '@/lib/buyback-copy';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Polycards — Physical & Digital Collectibles',
    short_name: 'Polycards',
    description: `Rip packs. Pull graded cards. Hold, redeem, or sell back at ${BUYBACK_RATE_LABEL} value.`,
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
