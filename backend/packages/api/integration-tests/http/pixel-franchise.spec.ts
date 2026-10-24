import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { asPixelPokemonCrud } from '../../src/modules/packs/pixel-pokemon-service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'pixel-franchise-test-pw-1'; // gitleaks:allow — throwaway test-DB admin
const ADMIN_EMAIL = 'admin-pixel-franchise@test.dev';

// One sprite library, separate decks (Migration20261021120000): Pokémon are
// numbered by dex, One Piece by `number`, one base ('normal') sprite per number
// per deck, variants share their character's number, and the list filters by
// deck — against the real schema, not mocks.
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('pixel sprite decks (franchise + number)', () => {
      let adminToken: string;
      beforeEach(async () => {
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
      });
      const headers = () => ({
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const create = (body: Record<string, unknown>) =>
        unwrapResponse(
          api.post(
            '/admin/pixel-pokemon',
            { image_url: 'https://example.com/sprite.gif', ...body },
            headers(),
          ),
        );

      it('numbers One Piece separately from the Pokédex and keeps one base per number', async () => {
        const luffy = await create({
          name: 'Monkey D. Luffy',
          franchise: 'one-piece',
          number: 1,
          variant: 'normal',
          types: ['One Piece'],
        });
        expect(luffy.status).toBe(201);
        expect(luffy.data.pixel_pokemon).toMatchObject({
          franchise: 'one-piece',
          number: 1,
          dex: null,
          is_custom: true,
        });

        // a second BASE One Piece #1 is refused…
        const dup = await create({
          name: 'Luffy again',
          franchise: 'one-piece',
          number: 1,
          variant: 'normal',
        });
        expect(dup.status).toBe(400);
        expect(dup.data.message).toMatch(
          /franchise: one-piece, number: 1, already exists/,
        );

        // …a variant shares the number…
        const gear5 = await create({
          name: 'Monkey D. Luffy (Gear 5)',
          franchise: 'one-piece',
          number: 1,
          variant: 'gear-5',
        });
        expect(gear5.status).toBe(201);

        // …and Pokémon numbering is its own space: dex 1 and One Piece #1 coexist.
        const bulbasaur = await create({
          name: 'Bulbasaur',
          dex: 1,
          variant: 'normal',
        });
        expect(bulbasaur.status).toBe(201);
        expect(bulbasaur.data.pixel_pokemon).toMatchObject({
          franchise: 'pokemon',
          dex: 1,
          number: null,
        });

        // a dex on a One Piece sprite never gets in
        const crossed = await create({
          name: 'Nami',
          franchise: 'one-piece',
          dex: 25,
        });
        expect(crossed.status).toBe(400);

        // …nor around the parser: the DB check refuses a crossed row.
        const pixels = asPixelPokemonCrud(
          getContainer().resolve<PacksModuleService>(PACKS_MODULE),
        );
        const row = {
          name: 'Crossed',
          variant: 'custom',
          types: [] as unknown as Record<string, unknown>,
          image_url: 'https://example.com/x.gif',
          image_key: null,
          is_custom: true,
        };
        await expect(
          pixels.createPixelPokemon([
            { ...row, franchise: 'one-piece', dex: 25, number: null },
          ]),
        ).rejects.toThrow(/pixel_pokemon_deck_numbering_check/);
        await expect(
          pixels.createPixelPokemon([
            { ...row, franchise: 'pokemon', dex: 25, number: 7 },
          ]),
        ).rejects.toThrow(/pixel_pokemon_deck_numbering_check/);
      });

      it('filters the library by deck and searches each deck by its own number', async () => {
        await create({
          name: 'Roronoa Zoro',
          franchise: 'one-piece',
          number: 2,
          variant: 'normal',
        });
        await create({ name: 'Ivysaur', dex: 2, variant: 'normal' });
        // created out of order — the deck list must still read #11 before #12
        await create({
          name: 'Zeta',
          franchise: 'one-piece',
          number: 12,
          variant: 'normal',
        });
        await create({
          name: 'Alpha',
          franchise: 'one-piece',
          number: 11,
          variant: 'normal',
        });

        const op = await unwrapResponse(
          api.get(
            '/admin/pixel-pokemon?franchise=one-piece&limit=200',
            headers(),
          ),
        );
        expect(op.status).toBe(200);
        expect(
          op.data.pixel_pokemon.every(
            (p: { franchise: string }) => p.franchise === 'one-piece',
          ),
        ).toBe(true);
        const names = op.data.pixel_pokemon.map(
          (p: { name: string }) => p.name,
        );
        expect(names.indexOf('Alpha')).toBeLessThan(names.indexOf('Zeta'));

        const byNumber = await unwrapResponse(
          api.get('/admin/pixel-pokemon?franchise=one-piece&q=2', headers()),
        );
        expect(
          byNumber.data.pixel_pokemon.map((p: { name: string }) => p.name),
        ).toEqual(['Roronoa Zoro']);

        const pokemon = await unwrapResponse(
          api.get('/admin/pixel-pokemon?franchise=pokemon&q=2', headers()),
        );
        expect(
          pokemon.data.pixel_pokemon.map((p: { name: string }) => p.name),
        ).toEqual(['Ivysaur']);
      });
    });
  },
});
