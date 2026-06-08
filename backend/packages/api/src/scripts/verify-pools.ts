// Dev verification for per-category gacha pools (Phase 8): opens one pack across
// several categories via the real openPackWorkflow and prints the rolled card, so
// you can confirm a pack only ever yields a card of its own category. Cleans up the
// temp pulls it creates. Run: corepack yarn medusa exec ./src/scripts/verify-pools.ts
import { ExecArgs } from "@medusajs/framework/types";
import { PACKS_MODULE } from "../modules/packs";
import { openPackWorkflow } from "../workflows/open-pack";

export default async function verifyPools({ container }: ExecArgs) {
  const packs = container.resolve(PACKS_MODULE);
  const customer_id = "verify-pools-temp";
  // Every active pack, so each pack in a multi-pack category is exercised (not
  // just one per category) — a pack only ever yields a card of its own category.
  const targets = [
    "pokemon-mythic", "pokemon-legend", "pokemon-elite", "pokemon-platinum", "pokemon-rookie",
    "onepiece-legend", "onepiece-platinum", "onepiece-elite", "onepiece-starter",
    "nba-black", "nba-legend", "nba-platinum",
    "baseball-pro", "baseball-legend", "baseball-starter",
    "football-elite", "football-starter", "football-platinum",
    "soccer-pro",
    "yugioh-pro",
    "riftbound-starter",
  ];
  // open each a few times so we sample more than one card from the pool
  for (const slug of targets) {
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { result } = await openPackWorkflow(container).run({
        input: { pack_id: slug, customer_id },
      });
      seen.push(result.card?.handle ?? "?");
    }
    console.log(`OPEN ${slug.padEnd(18)} -> ${seen.join(", ")}`);
  }
  const pulls = await packs.listPulls({ customer_id }, { take: 200 });
  if (pulls.length) {
    await packs.deletePulls(pulls.map((p: { id: string }) => p.id));
  }
  console.log(`\ncleaned up ${pulls.length} temp pull(s)`);
}
