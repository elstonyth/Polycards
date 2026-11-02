import { mediaHost } from '@/lib/security/csp';

/** True when next/image may optimize `src`: a local /public path, or a file on
 *  our own media host (next.config remotePatterns allows it, any path).
 *  next/image throws during render on a local path with a query string, and
 *  operator-entered art on any other host must stay `unoptimized`, or
 *  /_next/image answers 400 and the image breaks. */
export const isOptimizableImage = (src: string): boolean =>
  (src.startsWith('/') && !src.startsWith('//') && !src.includes('?')) ||
  src.startsWith(`https://${mediaHost()}/`);
