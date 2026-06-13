// Generate src/lib/mock/pokedex-names.ts from PokeAPI (national-dex order, 1..1025).
// Names are factual catalog data; sprites are hotlinked from PokeAPI at render time.
import { writeFileSync } from 'node:fs';

const res = await fetch('https://pokeapi.co/api/v2/pokemon?limit=1025', {
  headers: { 'User-Agent': 'Mozilla/5.0' },
});
const data = await res.json();

const titdle = (s) =>
  s
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ')
    // tidy common API suffixes
    .replace(/\bF$/, '♀')
    .replace(/\bM$/, '♂');

const names = data.results.map((p) => titdle(p.name));
console.log(
  `fetched ${names.length} names; first 6:`,
  names.slice(0, 6).join(', '),
);

const file =
  '// AUTO-GENERATED from PokeAPI (national-dex order). Index i => dex #(i+1).\n' +
  'export const POKEDEX_NAMES: string[] = ' +
  JSON.stringify(names) +
  ';\n';
writeFileSync('src/lib/mock/pokedex-names.ts', file, 'utf8');
console.log('wrote src/lib/mock/pokedex-names.ts');
