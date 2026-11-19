// The sleeve as one closed surface, in plain arrays so it can be checked
// without a GPU. Each row of the mesh is a ring around the sleeve's cross
// section: left fold, front face, right fold, back face, back to the left fold.
// The front and back share their vertices where they meet (down both side
// folds and along the sealed top and bottom edges), so normals and texture
// coordinates run straight across the hand-over: there is no gap, step or
// second edge to fight over at any angle.

import {
  PACK_PROPORTIONS,
  finRaise,
  halfDepth,
  outlineAt,
  type PackLayout,
  type PackProportions,
} from './pack-layout';

/** Mesh density. The defaults keep a pack near 6k triangles. */
export const PACK_DETAIL = {
  /** Segments around each side fold, front half and back half alike. */
  foldSegments: 4,
  /** Face segments left of the fin band and right of it. */
  leftSegments: 6,
  rightSegments: 8,
  /** Extra columns inside the fin band, beyond its two soft edges. */
  finInner: 2,
  /** Rows through each crimp, each shoulder and the belly. */
  crimpRows: 4,
  shoulderRows: 12,
  bellyRows: 12,
} as const;

export type PackDetail = { [K in keyof typeof PACK_DETAIL]: number };

export type PackSurface = {
  /** xyz per vertex. The sleeve is 1 tall, centred on the origin, front +z. */
  positions: Float32Array;
  normals: Float32Array;
  /** Front-art texture coordinates (v up). The back samples (1 - u, v). */
  uvs: Float32Array;
  /** 1 on the front, 0 on the back, 0.5 where they meet. */
  faces: Float32Array;
  indices: Uint16Array | Uint32Array;
  /** Rows top to bottom, vertices per ring. */
  rows: number;
  ring: number;
  /** Row heights (y fractions of the art, down from the top). */
  rowY: Float64Array;
};

const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x));

/** The heights (art y fractions) of the mesh rows, top to bottom. */
export function packRowStops(
  layout: PackLayout,
  shape: PackProportions = PACK_PROPORTIONS,
  detail: PackDetail = PACK_DETAIL,
): number[] {
  const { top, bottom, crimpTop, crimpBottom } = layout;
  const half: number[] = [top, top + 0.0012];
  // Flat seal: a few rows only, to carry the outline's rounded corners.
  for (let i = 1; i <= detail.crimpRows; i++)
    half.push(
      top + 0.0012 + ((crimpTop.y1 - top - 0.0012) * i) / detail.crimpRows,
    );
  // Shoulder: dense where the sleeve rises off the seal, easing out.
  const reach = shape.shoulder * 1.3;
  for (let i = 1; i <= detail.shoulderRows; i++) {
    const t = i / detail.shoulderRows;
    half.push(crimpTop.y1 + reach * t ** 1.6);
  }
  const bellyTop = crimpTop.y1 + reach;
  const bellyBottom = crimpBottom.y0 - reach;
  const rows: number[] = [...half];
  for (let i = 1; i < detail.bellyRows; i++)
    rows.push(bellyTop + ((bellyBottom - bellyTop) * i) / detail.bellyRows);
  // The bottom half mirrors the top half about the crimps.
  const mirrored = half.map((y) => {
    if (y <= crimpTop.y1) {
      const k = (y - top) / (crimpTop.y1 - top);
      return bottom - k * (bottom - crimpBottom.y0);
    }
    return crimpBottom.y0 - (y - crimpTop.y1);
  });
  for (let i = mirrored.length - 1; i >= 0; i--)
    rows.push(mirrored[i] as number);
  return rows;
}

/**
 * Column positions across one face, as `t` from the left fold's inner edge
 * (0) to the right fold's (1), for a face spanning `from`..`to` (front u).
 * Both faces use the same columns, so the back's fin band (with its soft
 * edges) is resolved on the front too, which is harmless.
 */
function faceColumns(
  layout: PackLayout,
  from: number,
  to: number,
  shape: PackProportions,
  detail: PackDetail,
): number[] {
  const e = shape.finEdge;
  const { x0, x1 } = layout.fin;
  const anchors = [
    x0 - 1.6 * e,
    x0 - 0.5 * e,
    x0 + 0.5 * e,
    x0 + 1.6 * e,
    ...Array.from(
      { length: detail.finInner },
      (_, i) =>
        x0 + 1.6 * e + ((x1 - x0 - 3.2 * e) * (i + 1)) / (detail.finInner + 1),
    ),
    x1 - 1.6 * e,
    x1 - 0.5 * e,
    x1 + 0.5 * e,
    x1 + 1.6 * e,
  ];
  const t = (u: number) => clamp((u - from) / (to - from), 0.02, 0.98);
  const first = t(anchors[0] as number);
  const last = t(anchors[anchors.length - 1] as number);
  const columns: number[] = [0];
  for (let i = 1; i < detail.leftSegments; i++)
    columns.push((first * i) / detail.leftSegments);
  for (const u of anchors) columns.push(t(u));
  for (let i = 1; i < detail.rightSegments; i++)
    columns.push(last + ((1 - last) * i) / detail.rightSegments);
  columns.push(1);
  return columns;
}

/**
 * Builds the closed sleeve for `layout`. Vertex xy is the art's own frame
 * (x = (u - 0.5) * aspect, y = 0.5 - artY), so the print maps 1:1 seen face on;
 * only the depth (z) is shaped.
 */
export function buildPackSurface(
  layout: PackLayout,
  shape: PackProportions = PACK_PROPORTIONS,
  detail: PackDetail = PACK_DETAIL,
): PackSurface {
  const rowY = packRowStops(layout, shape, detail);
  const rows = rowY.length;
  const F = detail.foldSegments;
  const inset = { x: layout.texel.x * 1.1, y: layout.texel.y * 1.1 };

  // Per-row ring: front half from left edge to right edge (inclusive), then
  // the back half from right to left (exclusive of both edges).
  const sampleColumns = faceColumns(
    layout,
    layout.body.x0,
    layout.body.x1,
    shape,
    detail,
  );
  const faceCount = sampleColumns.length; // includes t = 0 and t = 1
  const frontCount = 2 * F + faceCount; // left fold 0..F-1, face, right fold
  const ring = 2 * frontCount - 2;

  const positions = new Float32Array(rows * ring * 3);
  const uvs = new Float32Array(rows * ring * 2);
  const faces = new Float32Array(rows * ring);
  // Fold blend: the outermost fold segments hand the print over from one face
  // to the other; the rest of the fold is pure front (or back).
  const foldWeight = (i: number) =>
    i === 0 ? 0.5 : 0.5 + 0.5 * Math.min(1, i / Math.max(1, F - 1)) ** 0.75;

  for (let j = 0; j < rows; j++) {
    const y = rowY[j] as number;
    const span = outlineAt(layout, y);
    const columns = faceColumns(layout, span.x0, span.x1, shape, detail);
    const left = (span.x0 - 0.5) * layout.aspect;
    const right = (span.x1 - 0.5) * layout.aspect;
    const width = right - left;
    const depth = halfDepth(layout, y, shape);
    const edgeDepth = depth * (1 - shape.crownAcross);
    const fold = Math.min(shape.foldRatio * depth, width * 0.2);
    const yObj = 0.5 - y;
    const vTex = 1 - clamp(y, layout.top + inset.y, layout.bottom - inset.y);

    // Front half: [x, z, faceWeight] left to right.
    const front: Array<[number, number, number]> = [];
    for (let i = 0; i < F; i++) {
      const phi = ((i / F) * Math.PI) / 2;
      front.push([
        left + fold * (1 - Math.cos(phi)),
        edgeDepth * Math.sin(phi),
        foldWeight(i),
      ]);
    }
    for (const t of columns) {
      const x = left + fold + (width - 2 * fold) * t;
      const z = edgeDepth + (depth - edgeDepth) * 4 * t * (1 - t);
      front.push([x, z, 1]);
    }
    for (let i = F - 1; i >= 0; i--) {
      const phi = ((i / F) * Math.PI) / 2;
      front.push([
        right - fold * (1 - Math.cos(phi)),
        edgeDepth * Math.sin(phi),
        foldWeight(i),
      ]);
    }

    for (let k = 0; k < ring; k++) {
      // Back vertex k mirrors front vertex (2 * frontCount - 2 - k).
      const isFront = k < frontCount;
      const twin = isFront ? k : 2 * frontCount - 2 - k;
      const [x, z, w] = front[twin] as [number, number, number];
      const u = x / layout.aspect + 0.5;
      const zz = isFront ? z : -(z + finRaise(layout, u, y, shape));
      const o = j * ring + k;
      positions[o * 3] = x;
      positions[o * 3 + 1] = yObj;
      positions[o * 3 + 2] = zz;
      uvs[o * 2] = clamp(u, span.x0 + inset.x, span.x1 - inset.x);
      uvs[o * 2 + 1] = vTex;
      faces[o] = isFront ? w : 1 - w;
    }
  }

  // On the sealed top and bottom rows the two faces lie on one line: each
  // back vertex there is its front twin, which closes the surface.
  const vertexIndex = (j: number, k: number): number => {
    if ((j === 0 || j === rows - 1) && k >= frontCount)
      return j * ring + (2 * frontCount - 2 - k);
    return j * ring + k;
  };
  // Those shared vertices belong to both faces equally.
  for (const j of [0, rows - 1])
    faces.fill(0.5, j * ring, j * ring + frontCount);

  const triangles = (rows - 1) * ring * 2;
  const vertexCount = rows * ring;
  const indices =
    vertexCount > 65535
      ? new Uint32Array(triangles * 3)
      : new Uint16Array(triangles * 3);
  let n = 0;
  for (let j = 0; j < rows - 1; j++) {
    for (let k = 0; k < ring; k++) {
      const k2 = (k + 1) % ring;
      const a = vertexIndex(j, k);
      const b = vertexIndex(j, k2);
      const c = vertexIndex(j + 1, k);
      const d = vertexIndex(j + 1, k2);
      // Counter-clockwise seen from outside.
      indices[n++] = a;
      indices[n++] = c;
      indices[n++] = b;
      indices[n++] = b;
      indices[n++] = c;
      indices[n++] = d;
    }
  }

  return {
    positions,
    normals: computeNormals(positions, indices),
    uvs,
    faces,
    indices,
    rows,
    ring,
    rowY: Float64Array.from(rowY),
  };
}

/** Area-weighted vertex normals (unused vertices get +z). */
export function computeNormals(
  positions: Float32Array,
  indices: ArrayLike<number>,
): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = (indices[t] as number) * 3;
    const b = (indices[t + 1] as number) * 3;
    const c = (indices[t + 2] as number) * 3;
    const abx = (positions[b] as number) - (positions[a] as number);
    const aby = (positions[b + 1] as number) - (positions[a + 1] as number);
    const abz = (positions[b + 2] as number) - (positions[a + 2] as number);
    const acx = (positions[c] as number) - (positions[a] as number);
    const acy = (positions[c + 1] as number) - (positions[a + 1] as number);
    const acz = (positions[c + 2] as number) - (positions[a + 2] as number);
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const v of [a, b, c]) {
      normals[v] = (normals[v] as number) + nx;
      normals[v + 1] = (normals[v + 1] as number) + ny;
      normals[v + 2] = (normals[v + 2] as number) + nz;
    }
  }
  for (let v = 0; v < normals.length; v += 3) {
    const x = normals[v] as number;
    const y = normals[v + 1] as number;
    const z = normals[v + 2] as number;
    const length = Math.hypot(x, y, z);
    if (length > 0) {
      normals[v] = x / length;
      normals[v + 1] = y / length;
      normals[v + 2] = z / length;
    } else normals[v + 2] = 1;
  }
  return normals;
}

/** Signed volume of a closed triangle mesh: positive when it faces outward. */
export function signedVolume(
  positions: Float32Array,
  indices: ArrayLike<number>,
): number {
  const p = (i: number) => positions[i] as number;
  let volume = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = (indices[t] as number) * 3;
    const b = (indices[t + 1] as number) * 3;
    const c = (indices[t + 2] as number) * 3;
    // a . (b x c) / 6: the tetrahedron from the origin to this triangle.
    const cross = [
      p(b + 1) * p(c + 2) - p(b + 2) * p(c + 1),
      p(b + 2) * p(c) - p(b) * p(c + 2),
      p(b) * p(c + 1) - p(b + 1) * p(c),
    ] as const;
    volume += (p(a) * cross[0] + p(a + 1) * cross[1] + p(a + 2) * cross[2]) / 6;
  }
  return volume;
}

/**
 * Edges used by other than exactly two triangles, and edges two triangles
 * walk in the same direction (a flipped neighbour). Both empty means the mesh
 * is closed and consistently wound.
 */
export function openEdges(indices: ArrayLike<number>): {
  open: number;
  flipped: number;
} {
  const directed = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const from = indices[t + e] as number;
      const to = indices[t + ((e + 1) % 3)] as number;
      if (from === to) continue;
      const key = `${from}>${to}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  let open = 0;
  let flipped = 0;
  for (const [key, count] of directed) {
    if (count > 1) flipped += count - 1;
    const [from, to] = key.split('>');
    if (!directed.has(`${to}>${from}`)) open++;
  }
  return { open, flipped };
}
