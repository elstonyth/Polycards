let loaded: typeof import('@/lib/data/schemas') | null = null;

/** zod and every schema, on demand: ~95 KB of parsed JS that client components
 *  only need once a same-origin response arrives, so it stays out of first load.
 *  Server code imports '@/lib/data/schemas' directly. */
export async function loadSchemas() {
  return (loaded ??= await import('@/lib/data/schemas'));
}
