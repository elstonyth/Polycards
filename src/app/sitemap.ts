import type { MetadataRoute } from 'next';
import { SITE_URL, ROUTES } from '@/lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  return ROUTES.map((route) => ({
    url: `${SITE_URL}${route === '/' ? '' : route}`,
    changeFrequency: route === '/' ? 'daily' : 'weekly',
    priority: route === '/' ? 1 : 0.7,
  }));
}
