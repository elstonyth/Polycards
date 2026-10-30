import { mediaHost } from '@/lib/security/csp';

/** True when next/image may optimize `src`: a local /public path, or a file on
 *  our own media host (next.config remotePatterns allows it, any path).
 *  Operator-entered art on any other host must stay `unoptimized`, or
 *  /_next/image answers 400 and the image breaks. */
export const isOptimizableImage = (src: string): boolean =>
  (src.startsWith('/') && !src.startsWith('//')) ||
  src.startsWith(`https://${mediaHost()}/`);
