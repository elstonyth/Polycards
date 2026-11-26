// The three Polycards aircraft, built from numbers: no model files. Each is a
// lofted fuselage, wings and tail in one mesh with painted faces, plus the name
// on the fuselage and the mark on the fin.
//
// Built nose along +X with Z up (the drawing's axes), then turned so Y is up.

import * as THREE from 'three';
import type { PlaneKind } from '@/lib/draw-globe';

type Wing = {
  xle: number;
  cr: number;
  ct: number;
  span: number;
  sweep: number;
  /** Height on the fuselage, in fuselage radii: under it or on top. */
  z: number;
  dih: number;
  winglet?: number;
};
type Spec = {
  /** Nose to tail, in globe radii. Everything else is a share of it. */
  L: number;
  R: number;
  /** Where the nose ends and the tail cone starts, along the length. */
  tn: number;
  tt: number;
  hump?: [number, number];
  windows: [number, number];
  cockpit: [number, number];
  wing: Wing;
  engines: 'wing' | 'rear' | 'prop';
  engineAt: number[];
  engR: number;
  engL: number;
  ttail: boolean;
  fin: { xle: number; cr: number; ct: number; h: number; sweep: number };
  stab: { xle: number; cr: number; ct: number; span: number; sweep: number };
  belly: string;
  engine: string;
  mark: string;
  /** How high it cruises above the ground, in globe radii. */
  cruise: number;
};

const BODY = '#f6f6f6';
const GLASS = '#101826';
const WING = '#cfd4da';
const TAIL = '#111111';
const GOLD = '#f5a623';

export const PLANES: Record<PlaneKind, Spec> = {
  // First: a four-engine jumbo, gold underneath.
  jumbo: {
    L: 0.3,
    R: 0.06,
    tn: 0.13,
    tt: 0.66,
    hump: [0.06, 0.34],
    windows: [0.36, 0.66],
    cockpit: [0.05, 0.1],
    wing: {
      xle: 0.15,
      cr: 0.23,
      ct: 0.06,
      span: 0.46,
      sweep: 0.33,
      z: -0.5,
      dih: 0.05,
      winglet: 0.035,
    },
    engines: 'wing',
    engineAt: [0.3, 0.6],
    engR: 0.026,
    engL: 0.12,
    ttail: false,
    fin: { xle: -0.27, cr: 0.19, ct: 0.08, h: 0.2, sweep: 0.15 },
    stab: { xle: -0.35, cr: 0.1, ct: 0.045, span: 0.17, sweep: 0.08 },
    belly: GOLD,
    engine: GOLD,
    mark: GOLD,
    cruise: 0.17,
  },
  // Business: a T-tail jet, engines on the rear fuselage.
  jet: {
    L: 0.23,
    R: 0.052,
    tn: 0.2,
    tt: 0.6,
    windows: [0.4, 0.58],
    cockpit: [0.1, 0.17],
    wing: {
      xle: 0.02,
      cr: 0.2,
      ct: 0.06,
      span: 0.42,
      sweep: 0.2,
      z: -0.6,
      dih: 0.035,
      winglet: 0.06,
    },
    engines: 'rear',
    engineAt: [0],
    engR: 0.03,
    engL: 0.17,
    ttail: true,
    fin: { xle: -0.26, cr: 0.2, ct: 0.1, h: 0.19, sweep: 0.2 },
    stab: { xle: 0, cr: 0.085, ct: 0.04, span: 0.15, sweep: 0.06 },
    belly: '#2b2d31',
    engine: '#2b2d31',
    mark: '#ffffff',
    cruise: 0.14,
  },
  // Economy: a high-wing twin turboprop.
  prop: {
    L: 0.19,
    R: 0.062,
    tn: 0.13,
    tt: 0.62,
    windows: [0.34, 0.62],
    cockpit: [0.05, 0.1],
    wing: {
      xle: 0.1,
      cr: 0.11,
      ct: 0.065,
      span: 0.48,
      sweep: 0.025,
      z: 0.82,
      dih: 0,
    },
    engines: 'prop',
    engineAt: [0.3],
    engR: 0.022,
    engL: 0.15,
    ttail: true,
    fin: { xle: -0.27, cr: 0.18, ct: 0.1, h: 0.2, sweep: 0.14 },
    stab: { xle: 0, cr: 0.08, ct: 0.045, span: 0.16, sweep: 0.03 },
    belly: BODY,
    engine: BODY,
    mark: '#ffffff',
    cruise: 0.11,
  },
};

/** How far above the ground a parked plane's middle sits: belly and engines. */
export const groundHeight = (kind: PlaneKind) => 0.024 + 0.12 * PLANES[kind].L;

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const AX_Y = v(0, 1, 0);
const AX_Z = v(0, 0, 1);
const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** Collects painted triangles with their normals. */
class Mesh {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];

  private tri(
    p: THREE.Vector3[],
    n: THREE.Vector3[],
    colour: THREE.Color,
    flip: boolean,
  ) {
    const order = flip ? [0, 2, 1] : [0, 1, 2];
    for (const i of order) {
      this.pos.push(p[i]!.x, p[i]!.y, p[i]!.z);
      this.nrm.push(n[i]!.x, n[i]!.y, n[i]!.z);
      this.col.push(colour.r, colour.g, colour.b);
    }
  }

  /** A closed tube through rings of equal size, smooth along and around, with
   *  flat ends. `paint` colours the quad between ring i and i+1 at step j. */
  loft(
    rings: THREE.Vector3[][],
    paint: (i: number, j: number) => THREE.Color,
    ends: THREE.Color,
  ) {
    const m = rings[0]!.length;
    const centres = rings.map((r) =>
      r.reduce((c, p) => c.add(p), v(0, 0, 0)).multiplyScalar(1 / m),
    );
    const normals = rings.map((r) => r.map(() => v(0, 0, 0)));
    const quads: { i: number; j: number; k: number; flip: boolean }[] = [];
    const face = v(0, 0, 0);
    const mid = v(0, 0, 0);
    for (let i = 0; i < rings.length - 1; i++) {
      for (let j = 0; j < m; j++) {
        const k = (j + 1) % m;
        const a = rings[i]![j]!;
        const b = rings[i]![k]!;
        const c = rings[i + 1]![k]!;
        const d = rings[i + 1]![j]!;
        face.subVectors(c, a).cross(mid.subVectors(d, b));
        mid.copy(a).add(b).add(c).add(d).multiplyScalar(0.25);
        mid.sub(
          centres[i]!.clone()
            .add(centres[i + 1]!)
            .multiplyScalar(0.5),
        );
        const flip = face.dot(mid) < 0;
        if (flip) face.negate();
        for (const [ri, rj] of [
          [i, j],
          [i, k],
          [i + 1, k],
          [i + 1, j],
        ] as const) {
          normals[ri]![rj]!.add(face);
        }
        quads.push({ i, j, k, flip });
      }
    }
    normals.forEach((r) => r.forEach((n) => n.normalize()));
    for (const { i, j, k, flip } of quads) {
      const colour = paint(i, j);
      const p = [
        rings[i]![j]!,
        rings[i]![k]!,
        rings[i + 1]![k]!,
        rings[i + 1]![j]!,
      ];
      const n = [
        normals[i]![j]!,
        normals[i]![k]!,
        normals[i + 1]![k]!,
        normals[i + 1]![j]!,
      ];
      this.tri([p[0]!, p[1]!, p[2]!], [n[0]!, n[1]!, n[2]!], colour, flip);
      this.tri([p[0]!, p[2]!, p[3]!], [n[0]!, n[2]!, n[3]!], colour, flip);
    }
    const last = rings.length - 1;
    for (const [at, next] of [
      [0, 1],
      [last, last - 1],
    ] as const) {
      const out = centres[at]!.clone().sub(centres[next]!).normalize();
      const ring = rings[at]!;
      for (let j = 0; j < m; j++) {
        const a = ring[j]!;
        const b = ring[(j + 1) % m]!;
        face.subVectors(a, centres[at]!).cross(mid.subVectors(b, centres[at]!));
        this.tri(
          [centres[at]!, a, b],
          [out, out, out],
          ends,
          face.dot(out) < 0,
        );
      }
    }
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    return g.rotateX(-Math.PI / 2);
  }
}

/** One rounded wing section: `chord` back from its leading edge, `thick` along
 *  `across`. */
function section(
  le: THREE.Vector3,
  chord: number,
  thick: number,
  across: THREE.Vector3,
  steps = 12,
): THREE.Vector3[] {
  return Array.from({ length: steps }, (_, i) => {
    const a = (2 * Math.PI * i) / steps;
    return le
      .clone()
      .add(v(-chord * (0.5 - 0.5 * Math.cos(a)), 0, 0))
      .addScaledVector(across, (thick / 2) * Math.sin(a));
  });
}

function tube(
  front: THREE.Vector3,
  length: number,
  r: number,
  profile: [number, number][],
  steps = 14,
): THREE.Vector3[][] {
  return profile.map(([s, k]) =>
    Array.from({ length: steps }, (_, j) => {
      const a = (2 * Math.PI * j) / steps;
      return v(
        front.x - s * length,
        front.y + r * k * Math.sin(a),
        front.z + r * k * Math.cos(a),
      );
    }),
  );
}

const JET: [number, number][] = [
  [0, 0.84],
  [0.08, 0.98],
  [0.3, 1],
  [0.7, 0.9],
  [1, 0.58],
];
const TURBOPROP: [number, number][] = [
  [-0.12, 0.05],
  [-0.04, 0.42],
  [0.05, 0.9],
  [0.4, 1],
  [1, 0.45],
];

function decal(
  corners: THREE.Vector3[],
  u0: number,
  u1: number,
  material: THREE.Material,
): THREE.Mesh {
  const [bl, br, tr, tl] = corners as [
    THREE.Vector3,
    THREE.Vector3,
    THREE.Vector3,
    THREE.Vector3,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [bl, br, tr, bl, tr, tl].flatMap((p) => [p.x, p.y, p.z]),
      3,
    ),
  );
  g.setAttribute(
    'uv',
    new THREE.Float32BufferAttribute(
      [u0, 0, u1, 0, u1, 1, u0, 0, u1, 1, u0, 1],
      2,
    ),
  );
  return new THREE.Mesh(g.rotateX(-Math.PI / 2), material);
}

/** The logo image: the mark is its left part, the whole is mark and name. */
const LOGO_ASPECT = 1440 / 388;
const MARK_U = 0.155;

export function buildPlane(kind: PlaneKind, logo: THREE.Texture): THREE.Group {
  const sp = PLANES[kind];
  const L = sp.L;
  const R = sp.R * L;
  const c = {
    body: new THREE.Color(BODY),
    glass: new THREE.Color(GLASS),
    belly: new THREE.Color(sp.belly),
    wing: new THREE.Color(WING),
    tail: new THREE.Color(TAIL),
    engine: new THREE.Color(sp.engine),
  };
  const mesh = new Mesh();
  const group = new THREE.Group();
  const paintAll = (colour: THREE.Color) => () => colour;

  // Fuselage: pointed nose, straight barrel, a tail cone that sweeps up.
  const N = 64;
  const M = 24;
  const ts: number[] = [];
  const rings: THREE.Vector3[][] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    let r = R;
    let zc = 0;
    if (t < sp.tn) {
      const u = t / sp.tn;
      r = R * Math.max(Math.sin((u * Math.PI) / 2) ** 0.75, 0.03);
      zc = -R * 0.22 * (1 - u) ** 2;
    } else if (t >= sp.tt) {
      const w = (t - sp.tt) / (1 - sp.tt);
      r = R * Math.max(1 - 0.9 * w ** 1.5, 0.05);
      zc = R * 0.8 * w ** 1.6;
    }
    const hz = sp.hump
      ? 1 +
        0.34 *
          smooth((t - sp.hump[0]) / 0.07) *
          (1 - smooth((t - sp.hump[1]) / 0.12))
      : 1;
    ts.push(t);
    rings.push(
      Array.from({ length: M }, (_, j) => {
        const ph = (2 * Math.PI * (j + 0.5)) / M;
        const cos = Math.cos(ph);
        return v(
          L / 2 - t * L,
          r * Math.sin(ph),
          zc + r * cos * (cos > 0 ? hz : 1),
        );
      }),
    );
  }
  mesh.loft(
    rings,
    (i, j) => {
      const t = (ts[i]! + ts[i + 1]!) / 2;
      const deg = ((j + 1) * 360) / M;
      const a = Math.min(deg, 360 - deg);
      const row = i % 2 === 0;
      if (t >= sp.cockpit[0] && t <= sp.cockpit[1] && a < 62) return c.glass;
      if (t >= sp.windows[0] && t <= sp.windows[1] && row && a > 73 && a < 84) {
        return c.glass;
      }
      if (
        sp.hump &&
        t >= sp.hump[0] + 0.05 &&
        t <= sp.hump[1] &&
        row &&
        a > 50 &&
        a < 62
      ) {
        return c.glass;
      }
      return a >= 112 ? c.belly : c.body;
    },
    c.body,
  );

  // Wings, their engines, and the tail.
  const wg = sp.wing;
  const zw = wg.z * R;
  for (const s of [1, -1]) {
    const at = (fr: number) =>
      v(
        (wg.xle - wg.sweep * fr) * L,
        s * fr * wg.span * L,
        zw + wg.dih * L * fr,
      );
    const secs = [
      section(at(0), wg.cr * L, 0.13 * wg.cr * L, AX_Z),
      section(at(1), wg.ct * L, 0.11 * wg.ct * L, AX_Z),
    ];
    if (wg.winglet) {
      const h = wg.winglet * L;
      secs.push(
        section(
          v(
            (wg.xle - wg.sweep - 0.55 * wg.ct) * L,
            s * (wg.span * L + h * 0.25),
            zw + wg.dih * L + h,
          ),
          0.45 * wg.ct * L,
          0.012 * L,
          AX_Y,
        ),
      );
    }
    mesh.loft(secs, paintAll(c.wing), c.wing);

    const rn = sp.engR * L;
    const ln = sp.engL * L;
    for (const fr of sp.engineAt) {
      if (sp.engines === 'wing') {
        const front = at(fr).add(v(0.07 * L, 0, -rn * 1.55));
        mesh.loft(tube(front, ln, rn, JET), paintAll(c.engine), c.glass);
        mesh.loft(
          [
            section(
              front.clone().add(v(-0.2 * ln, 0, rn * 0.6)),
              0.75 * ln,
              0.35 * rn,
              AX_Y,
            ),
            section(at(fr).add(v(-0.1 * ln, 0, 0)), 0.75 * ln, 0.35 * rn, AX_Y),
          ],
          paintAll(c.wing),
          c.wing,
        );
      } else if (sp.engines === 'prop') {
        const front = at(fr).add(v(0.075 * L, 0, -rn * 0.9));
        mesh.loft(tube(front, ln, rn, TURBOPROP), paintAll(c.engine), c.engine);
        // The spinning propeller, as the blur it makes.
        const disc = new THREE.Mesh(
          new THREE.CircleGeometry(0.062 * L, 28),
          new THREE.MeshBasicMaterial({
            color: 0xdfe4ea,
            transparent: true,
            opacity: 0.3,
            depthWrite: false,
            side: THREE.DoubleSide,
          }),
        );
        disc.position.set(front.x + 0.012 * L, front.z, -front.y);
        disc.rotation.y = Math.PI / 2;
        group.add(disc);
      } else {
        const front = v(-0.13 * L, s * (R + rn * 1.35), 0.45 * R);
        mesh.loft(tube(front, ln, rn, JET), paintAll(c.engine), c.glass);
        mesh.loft(
          [
            section(
              v(front.x - 0.2 * ln, s * R * 0.7, front.z),
              0.6 * ln,
              0.3 * rn,
              AX_Z,
            ),
            section(
              v(front.x - 0.2 * ln, front.y, front.z),
              0.6 * ln,
              0.3 * rn,
              AX_Z,
            ),
          ],
          paintAll(c.body),
          c.body,
        );
      }
    }
  }
  const fn = sp.fin;
  const finRoot = v(fn.xle * L, 0, 0.6 * R);
  const finTip = v((fn.xle - fn.sweep) * L, 0, 0.6 * R + fn.h * L);
  mesh.loft(
    [
      section(finRoot, fn.cr * L, 0.11 * fn.cr * L, AX_Y),
      section(finTip, fn.ct * L, 0.11 * fn.ct * L, AX_Y),
    ],
    paintAll(c.tail),
    c.tail,
  );
  const st = sp.stab;
  for (const s of [1, -1]) {
    const root = sp.ttail
      ? finTip.clone().add(v(0.01 * L, 0, -0.004 * L))
      : v(st.xle * L, 0, 0.5 * R);
    mesh.loft(
      [
        section(root, st.cr * L, 0.1 * st.cr * L, AX_Z),
        section(
          root.clone().add(v(-st.sweep * L, s * st.span * L, 0.01 * L)),
          st.ct * L,
          0.1 * st.ct * L,
          AX_Z,
        ),
      ],
      paintAll(c.wing),
      c.wing,
    );
  }

  group.add(
    new THREE.Mesh(
      mesh.geometry(),
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.38,
        metalness: 0.05,
      }),
    ),
  );

  // Livery: the name on both sides of the forward fuselage, the mark on the fin.
  const paintOn = (tint: string) =>
    new THREE.MeshBasicMaterial({
      map: logo,
      color: tint,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
  const nameInk = paintOn('#111111');
  const markInk = paintOn(sp.mark);
  const hz = sp.hump ? 1.34 : 1;
  const hgt = R * (sp.hump ? 0.8 : 1);
  const wid = hgt * LOGO_ASPECT;
  const ang = ((sp.hump ? 80 : 60) * Math.PI) / 180;
  const xf = (0.5 - sp.cockpit[1] - 0.025) * L;
  for (const s of [1, -1]) {
    const nrm = v(0, s * Math.sin(ang), Math.cos(ang) / hz).normalize();
    const up = v(0, -s * nrm.z, s * nrm.y).multiplyScalar(hgt / 2);
    const cen = v(
      0,
      s * Math.sin(ang) * R,
      Math.cos(ang) * R * hz,
    ).addScaledVector(nrm, R * 0.02);
    const [a, b] = s === 1 ? [xf, xf - wid] : [xf - wid, xf];
    const low = cen.clone().sub(up);
    const high = cen.clone().add(up);
    group.add(
      decal(
        [
          low.clone().setX(a),
          low.clone().setX(b),
          high.clone().setX(b),
          high.clone().setX(a),
        ],
        0,
        1,
        nameInk,
      ),
    );
    const ih = fn.h * L * 0.42;
    const iw = (ih * MARK_U * 1440) / 388;
    const fz = 0.6 * R + fn.h * L * 0.5;
    const chord = ((fn.cr + fn.ct) / 2) * L;
    const xc = (fn.xle - fn.sweep * 0.5) * L - chord * 0.5;
    const y = s * ((0.11 * chord) / 2 + 0.0015 * L);
    const [fa, fb] =
      s === 1 ? [xc + iw / 2, xc - iw / 2] : [xc - iw / 2, xc + iw / 2];
    group.add(
      decal(
        [
          v(fa, y, fz - ih / 2),
          v(fb, y, fz - ih / 2),
          v(fb, y, fz + ih / 2),
          v(fa, y, fz + ih / 2),
        ],
        0,
        MARK_U,
        markInk,
      ),
    );
  }
  return group;
}
