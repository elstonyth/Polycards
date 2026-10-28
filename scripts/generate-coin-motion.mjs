// Asset-time physics only. Runtime replays a trace matching the server receipt.
import RAPIER from '@dimforge/rapier3d-compat';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
await RAPIER.init();
const traces = [];
for (const profile of ['soft', 'firm']) {
  for (const won of [true, false]) {
    for (let seed = 0; seed < 160; seed++) {
      const world = new RAPIER.World({ x: 0, y: -22, z: 0 });
      world.timestep = 1 / 120;
      world.numSolverIterations = 12;
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(12, 0.1, 12)
          .setTranslation(0, -0.1, 0)
          .setFriction(0.8),
      );
      const coin = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(0, 1, 0)
          .setRotation({ x: Math.sin(0.32), y: 0, z: 0, w: Math.cos(0.32) })
          .setLinvel(0.15, profile === 'firm' ? 7.5 : 6, 0)
          .setAngvel({ x: 20 + seed * 0.3, y: 0.7, z: 0.5 })
          .setLinearDamping(0.12)
          .setAngularDamping(0.4)
          .setCcdEnabled(true),
      );
      world.createCollider(
        RAPIER.ColliderDesc.cylinder(0.065, 0.72)
          .setMass(0.04)
          .setFriction(0.85)
          .setRestitution(0.27),
        coin,
      );
      const frames = [];
      const impacts = [];
      const sample = () => {
        const p = coin.translation();
        const q = coin.rotation();
        frames.push(
          [p.x, p.y, p.z, q.x, q.y, q.z, q.w].map((n) => Number(n.toFixed(5))),
        );
      };
      sample();
      let lastVy = coin.linvel().y;
      for (let step = 1; step <= 840; step++) {
        world.step();
        const vy = coin.linvel().y;
        if (
          vy - lastVy > 1.4 &&
          lastVy < -1 &&
          (impacts.length === 0 || step / 120 - impacts.at(-1) > 0.09)
        )
          impacts.push(step / 120);
        lastVy = vy;
        if (step % 2 === 0) sample();
        if (coin.isSleeping() && step > 180) break;
      }
      const q = coin.rotation();
      const normalY = 1 - 2 * (q.x * q.x + q.z * q.z);
      const p = coin.translation();
      const valid =
        Math.abs(normalY) > 0.997 &&
        normalY > 0 === won &&
        p.y < 0.09 &&
        Math.hypot(p.x, p.z) < 1.5 &&
        frames.length < 330 &&
        coin.isSleeping() &&
        impacts.length > 0;
      world.free();
      if (!valid) continue;
      assert(frames.every((f) => f.every(Number.isFinite)));
      assert(frames.every((f) => f[1] >= 0 && Math.hypot(f[0], f[2]) < 2));
      traces.push({
        profile,
        won,
        fps: 60,
        frames,
        impacts: impacts.map((t) => Number(t.toFixed(4))),
      });
      console.log(
        `${profile}/${won ? 'emblem' : 'wordmark'}: ${frames.length} frames, seed ${seed}, normal ${normalY.toFixed(4)}`,
      );
      break;
    }
  }
}
assert.equal(
  traces.length,
  4,
  'Both faces must have a bounded, physically settled trace for every profile.',
);
await mkdir('public/coin-flip', { recursive: true });
await writeFile('public/coin-flip/motion.json', JSON.stringify(traces));
