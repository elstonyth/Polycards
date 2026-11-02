// Asset-time physics only. Runtime replays a trace matching the server receipt.
import RAPIER from '@dimforge/rapier3d-compat';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
await RAPIER.init();
const traces = [];
// The coin's face normal and the drawn rim's height above the table, as CoinScene draws them.
function pose(f) {
  const [, , , x, y, z, w] = f;
  const ny = 1 - 2 * (x * x + z * z);
  const c = Math.min(1, Math.abs(ny));
  const s = Math.sqrt(1 - c * c);
  return {
    nx: 2 * (x * y - w * z),
    ny,
    nz: 2 * (y * z + w * x),
    clearance: f[1] - Math.max(...RIM.map(([r, h]) => r * s + h * c)) + 0.006,
  };
}
// Same rule as coinSoundEvents' wind: a grain each time the airborne coin passes
// edge-on. At least two before the first landing, and none after it.
function windOk(frames, impacts) {
  let edge = 0;
  let last = -1;
  let before = 0;
  for (let i = 0; i < frames.length; i++) {
    const t = i / 60;
    const { ny, clearance } = pose(frames[i]);
    if (clearance <= 0.03) {
      edge = 0;
      continue;
    }
    const sign = Math.sign(ny);
    if (edge && sign && sign !== edge && t - last > 0.05) {
      if (t >= impacts[0]) return false;
      before += 1;
      last = t;
    }
    if (sign) edge = sign;
  }
  return before >= 2;
}
// Same rule as coinSoundEvents: a tick per quarter turn of the wobble once it lands.
function rattles(frames, impacts) {
  let quarter = null;
  let last = -1;
  let count = 0;
  frames.forEach((f, i) => {
    const t = i / 60;
    const { nx, ny, nz, clearance } = pose(f);
    if (clearance > 0.03) {
      quarter = null;
      return;
    }
    if (t < (impacts[0] ?? Infinity)) return;
    const up = Math.sign(ny) || 1;
    const tilt = Math.asin(Math.min(1, Math.hypot(nx * up, nz * up)));
    const next = Math.floor(
      (Math.atan2(nz * up, nx * up) + Math.PI) / (Math.PI / 2),
    );
    if (
      quarter !== null &&
      next !== quarter &&
      tilt > 0.005 &&
      t - last > 0.03
    ) {
      count += 1;
      last = t;
    }
    quarter = next;
  });
  return count;
}
// How far apart a win and a loss are to the ear and the clock.
const gap = (a, b) =>
  a.impacts.length !== b.impacts.length
    ? Infinity
    : Math.abs(a.frames.length - b.frames.length) / 60 +
      a.impacts.reduce((sum, t, i) => sum + Math.abs(t - b.impacts[i]), 0) +
      Math.abs(rattles(a.frames, a.impacts) - rattles(b.frames, b.impacts)) *
        0.05;
// Drawn rim profile (radius, half-height) from CoinScene. Soft contacts let the collider sink into
// the table at impacts and while it wobbles to rest, so each sample is lifted until the drawn rim
// rests 0.001 above the drawn floor (-0.006).
const RIM = [
  [0.717, 0.04],
  [0.706, 0.056],
  [0.687, 0.069],
  [0.664, 0.069],
  [0.657, 0.066],
];
const RIM_FLOOR = -0.005;
// Linear and angular velocity both grow with release strength.
// https://rapier.rs/docs/user_guides/javascript/rigid_body_velocity/
for (const profile of [0, 0.25, 0.5, 0.75, 1]) {
  const found = { true: [], false: [] };
  for (const won of [true, false]) {
    for (let seed = 0; seed < 400; seed++) {
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
          .setLinvel(0.1, 4.5 + profile * 4, 0)
          .setAngvel({ x: 14 + profile * 12 + seed * 0.03, y: 0.5, z: 0.35 })
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
        const c = Math.min(1, Math.abs(1 - 2 * (q.x * q.x + q.z * q.z)));
        const s = Math.sqrt(1 - c * c);
        const y = Math.max(
          p.y,
          RIM_FLOOR + Math.max(...RIM.map(([r, h]) => r * s + h * c)),
        );
        frames.push(
          [p.x, y, p.z, q.x, q.y, q.z, q.w].map((n) => Number(n.toFixed(5))),
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
      found[won].push({
        profile,
        won,
        fps: 60,
        frames,
        impacts: impacts.map((t) => Number(t.toFixed(4))),
        seed,
      });
    }
  }
  // Pick the closest win and loss, then hold the shorter at rest: every toss of one
  // strength takes the same time, so timing and sound never give away the face.
  // This strength rolls on the rim, and both faces must, or the roll is the tell.
  const fits = (t) =>
    windOk(t.frames, t.impacts) &&
    t.frames.length < 210 &&
    (profile !== 0.25 || rattles(t.frames, t.impacts) > 12);
  let best = null;
  for (const a of found.true.filter(fits))
    for (const b of found.false.filter(fits)) {
      const d = gap(a, b);
      if (!best || d < best.d) best = { a, b, d };
    }
  assert(
    best && Number.isFinite(best.d),
    `No matching win and loss for ${profile}`,
  );
  const length = Math.max(best.a.frames.length, best.b.frames.length);
  for (const { seed, ...trace } of [best.a, best.b]) {
    const rest = trace.frames.at(-1);
    while (trace.frames.length < length) trace.frames.push(rest);
    traces.push(trace);
    console.log(
      `${profile}/${trace.won ? 'emblem' : 'wordmark'}: ${length} frames, seed ${seed}, ${trace.impacts.length} impacts, ${rattles(trace.frames, trace.impacts)} rattles`,
    );
  }
  console.log(
    `  gap ${best.d.toFixed(3)} from ${found.true.length} wins, ${found.false.length} losses`,
  );
}
assert.equal(
  traces.length,
  10,
  'Both faces must have a bounded, physically settled trace for every profile.',
);
await mkdir('public/coin-flip', { recursive: true });
await writeFile('public/coin-flip/motion.json', JSON.stringify(traces));
