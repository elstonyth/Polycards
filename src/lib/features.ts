// Feature toggles for temporarily hidden sections.
//
// Each flag is OFF unless its env var is exactly "true" — so the hidden state is
// the safe default and the deploy needs zero env config to ship Packs-only.
// Set the var to "true" (in the deploy env, or .env.local for local work) and
// rebuild to bring the feature back. NEXT_PUBLIC_ so the value is inlined for
// both server and client components.
export const features = {
  marketplace: process.env.NEXT_PUBLIC_FEATURE_MARKETPLACE === 'true',
  packParty: process.env.NEXT_PUBLIC_FEATURE_PACK_PARTY === 'true',
} as const;
