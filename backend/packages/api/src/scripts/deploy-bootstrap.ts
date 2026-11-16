import { ExecArgs } from '@medusajs/framework/types';
import createAdmin from './create-admin';
import seedVipLevels from './seed-vip-achievements';

// The migrate job's post-migration steps in ONE `medusa exec`, so a deploy
// boots the app once instead of once per script (~30 s and one Postgres pool
// fewer per deploy). Same order and behaviour as the old
// `exec create-admin.ts && exec seed-vip-achievements.ts` chain: a throw stops
// the run non-zero; create-admin's soft skips (no ADMIN_PASSWORD, register
// failure) only return, so the VIP seed still runs. Both steps are idempotent.
// Run: medusa exec ./src/scripts/deploy-bootstrap.ts
export default async function deployBootstrap(args: ExecArgs) {
  await createAdmin(args);
  await seedVipLevels(args);
}
