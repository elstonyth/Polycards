// The Draw page's globe, in plain three.js: the earth, its clouds, one plane a
// gate and the route it flies. The page draws the pins itself, as HTML: every
// frame this hands back where each plane is on screen.
//
// The globe turns under a fixed camera. Left alone it sways a little either
// side of the flights; a drag spins it; focusing a flight turns that plane to
// the camera and moves in.

import * as THREE from 'three';
import { flightPose, ROUTES, toVec, type PlaneKind } from '@/lib/draw-globe';
import { buildPlane, groundHeight, PLANES } from './planes';

export type GlobeFlight = {
  id: string;
  kind: PlaneKind;
  /** Index into ROUTES. */
  route: number;
  /** 0 at take-off to 1 landed. */
  progress: number;
};
/** Where a plane's pin goes, in CSS px from the stage's top left. */
export type GlobeAnchor = { id: string; x: number; y: number; hidden: boolean };

export type GlobeSceneOptions = {
  reducedMotion: boolean;
  onReady: () => void;
  onFrame: (anchors: readonly GlobeAnchor[]) => void;
  /** A tap on a plane, or on nothing (null). */
  onPick: (id: string | null) => void;
};

export type GlobeScene = {
  setFlights: (flights: readonly GlobeFlight[]) => void;
  /** Turn a plane to the camera and move in, its pin point `anchorY` px down
   *  the stage; null goes back out. */
  focus: (id: string | null, anchorY?: number) => void;
  dispose: () => void;
};

const ASSETS = '/images/lucky-draw/globe/';
const LOGO = '/branding/polycards-logo-4x.png';
const FOV = 30;
const TAN = Math.tan((FOV * Math.PI) / 360);
// A focused plane sits this far below the middle of the view, so it is seen
// from above and behind with the horizon over it.
const FOCUS_TILT = 0.6;
const SWAY = 0.5;
const IDLE_MS = 4000;

type Flight = GlobeFlight & {
  plane: THREE.Group;
  marks: THREE.Group;
  anchor: GlobeAnchor;
};

const wrapNear = (angle: number, near: number) =>
  angle + Math.round((near - angle) / (2 * Math.PI)) * 2 * Math.PI;

/** Throws when WebGL is not there: the caller falls back to the list. */
export function createGlobeScene(
  host: HTMLElement,
  opts: GlobeSceneOptions,
): GlobeScene {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.className = 'block h-full w-full touch-pan-y cursor-grab';
  canvas.setAttribute('aria-hidden', 'true');
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 60);
  scene.add(new THREE.HemisphereLight(0xcfe2ff, 0x1c2c48, 1.3));
  const sun = new THREE.DirectionalLight(0xffffff, 2.7);
  sun.position.set(-3, 4, 6);
  scene.add(sun);

  const loader = new THREE.TextureLoader();
  const owned: { dispose: () => void }[] = [];
  const keep = <T extends { dispose: () => void }>(thing: T): T => {
    owned.push(thing);
    return thing;
  };
  let live = true;
  const texture = (url: string, colour: boolean, done?: () => void) => {
    const t = keep(loader.load(url, () => live && done?.()));
    if (colour) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return t;
  };
  const relief = texture(`${ASSETS}relief.webp`, false);
  const cover = texture(`${ASSETS}clouds.webp`, false);
  const logo = texture(LOGO, true);

  const world = new THREE.Group();
  world.rotation.order = 'XYZ';
  scene.add(world);
  const ball = keep(new THREE.SphereGeometry(1, 192, 96));
  world.add(
    new THREE.Mesh(
      ball,
      keep(
        new THREE.MeshStandardMaterial({
          map: texture(`${ASSETS}earth.webp`, true, opts.onReady),
          displacementMap: relief,
          displacementScale: 0.022,
          bumpMap: relief,
          bumpScale: 2.5,
          roughnessMap: relief,
          roughness: 1,
          metalness: 0,
        }),
      ),
    ),
  );
  const shell = keep(new THREE.SphereGeometry(1, 96, 48));
  const cloudShade = new THREE.Mesh(
    shell,
    keep(
      new THREE.MeshBasicMaterial({
        color: 0x061a3a,
        alphaMap: cover,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
      }),
    ),
  );
  cloudShade.scale.setScalar(1.03);
  const clouds = new THREE.Mesh(
    shell,
    keep(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        alphaMap: cover,
        transparent: true,
        depthWrite: false,
        roughness: 1,
      }),
    ),
  );
  clouds.scale.setScalar(1.075);
  clouds.rotation.set(0.3, 0, 0.2);
  cloudShade.rotation.set(0.3, -0.03, 0.2);
  world.add(cloudShade, clouds);
  // The rim of air: a soft blue disc behind the globe, showing round its edge.
  const air = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(3.2, 3.2)),
    keep(
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        vertexShader:
          'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader:
          'varying vec2 vUv; void main(){ float r = length(vUv - 0.5) * 3.2; float a = smoothstep(1.34, 1.0, r); gl_FragColor = vec4(0.36, 0.66, 1.0, a * a * 0.7); }',
      }),
    ),
  );
  air.renderOrder = -1;
  scene.add(air);

  const dotGeo = keep(new THREE.SphereGeometry(0.0055, 6, 4));
  const spotGeo = keep(new THREE.CircleGeometry(0.012, 20));
  const ringGeo = keep(new THREE.RingGeometry(0.026, 0.034, 36));
  const white = keep(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const grey = keep(new THREE.MeshBasicMaterial({ color: 0xa0a6ad }));

  const flights = new Map<string, Flight>();
  let signature = '';
  const tmpM = new THREE.Matrix4();
  const X = new THREE.Vector3();
  const Y = new THREE.Vector3();
  const Zv = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 0, 1);

  const disposeTree = (root: THREE.Object3D) => {
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const shared =
        o.geometry === dotGeo ||
        o.geometry === spotGeo ||
        o.geometry === ringGeo;
      if (!shared) o.geometry.dispose();
      const m = o.material as THREE.Material;
      if (m !== white && m !== grey) m.dispose();
    });
  };

  const place = (f: Flight) => {
    const [from, to] = ROUTES[f.route]!;
    const pose = flightPose(
      from,
      to,
      f.progress,
      PLANES[f.kind].cruise,
      groundHeight(f.kind),
    );
    X.set(...pose.forward);
    Y.set(...pose.up);
    Zv.crossVectors(X, Y).normalize();
    Y.crossVectors(Zv, X);
    f.plane.position.set(...pose.position);
    f.plane.quaternion.setFromRotationMatrix(tmpM.makeBasis(X, Y, Zv));
  };

  const routeMarks = (f: GlobeFlight): THREE.Group => {
    const [from, to] = ROUTES[f.route]!;
    const g = new THREE.Group();
    const ink = f.progress >= 1 ? grey : white;
    const a = new THREE.Vector3(...toVec(from));
    const b = new THREE.Vector3(...toVec(to));
    const n = Math.max(8, Math.round((a.angleTo(b) * 180) / Math.PI / 1.7));
    const dots = new THREE.InstancedMesh(dotGeo, ink, n - 1);
    for (let i = 1; i < n; i++) {
      const p = flightPose(
        from,
        to,
        i / n,
        PLANES[f.kind].cruise,
        groundHeight(f.kind),
      ).position;
      dots.setMatrixAt(i - 1, tmpM.makeTranslation(...p));
    }
    g.add(dots);
    for (const [dir, geos] of [
      [a, [spotGeo]],
      [b, [spotGeo, ringGeo]],
    ] as const) {
      for (const geo of geos) {
        const m = new THREE.Mesh(geo, ink);
        m.position.copy(dir).multiplyScalar(1.03);
        m.quaternion.setFromUnitVectors(UP, dir);
        g.add(m);
      }
    }
    return g;
  };

  // ---- view state: where the globe is turned, how near the camera is
  let width = 1;
  let height = 1;
  let yaw = 0;
  let pitch = 0.2;
  let dist = 8;
  let lift = 0;
  let homeYaw = 0;
  let homePitch = 0.2;
  let placed = false;
  let focusId: string | null = null;
  let focusY = 0;
  let dragging = false;
  let spin = 0;
  let touchedAt = -Infinity;
  const overview = () =>
    Math.max(1.16 / (TAN * camera.aspect * 0.98), 1.16 / (TAN * 0.8));

  const setHome = () => {
    const mean = new THREE.Vector3();
    flights.forEach((f) => mean.add(f.plane.position.clone().normalize()));
    if (mean.lengthSq() < 1e-6) mean.set(...toVec([105, 5]));
    mean.normalize();
    homeYaw = -Math.PI / 2 - Math.atan2(-mean.z, mean.x);
    homePitch = Math.min(0.6, Math.max(-0.5, Math.asin(mean.y) + 0.1));
    if (!placed) {
      placed = true;
      yaw = homeYaw;
      pitch = homePitch;
      dist = overview();
    }
  };

  const api: GlobeScene = {
    setFlights(next) {
      const sig = next
        .map((f) => `${f.id}:${f.kind}:${f.route}:${f.progress >= 1}`)
        .join('|');
      if (sig !== signature) {
        signature = sig;
        flights.forEach((f) => {
          world.remove(f.plane, f.marks);
          disposeTree(f.plane);
          disposeTree(f.marks);
        });
        flights.clear();
        for (const f of next) {
          const plane = buildPlane(f.kind, logo);
          const marks = routeMarks(f);
          world.add(plane, marks);
          flights.set(f.id, {
            ...f,
            plane,
            marks,
            anchor: { id: f.id, x: 0, y: 0, hidden: true },
          });
        }
      }
      for (const f of next) {
        const mine = flights.get(f.id);
        if (!mine) continue;
        mine.progress = f.progress;
        place(mine);
      }
      setHome();
    },
    focus(id, anchorY) {
      focusId = id && flights.has(id) ? id : null;
      focusY = anchorY ?? height * 0.72;
      touchedAt = performance.now();
    },
    dispose() {
      live = false;
      cancelAnimationFrame(frame);
      resize.disconnect();
      seen.disconnect();
      document.removeEventListener('visibilitychange', wake);
      flights.forEach((f) => {
        disposeTree(f.plane);
        disposeTree(f.marks);
      });
      owned.forEach((o) => o.dispose());
      renderer.dispose();
      canvas.remove();
    },
  };

  // ---- pointer: a drag spins, a tap picks
  let downX = 0;
  let downY = 0;
  let lastX = 0;
  let lastY = 0;
  let lastT = 0;
  let moved = false;
  let pointer: number | null = null;
  const pxPerRadian = () => height / 2 / (dist * TAN);
  canvas.addEventListener('pointerdown', (e) => {
    if (pointer !== null) return;
    pointer = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    downX = lastX = e.clientX;
    downY = lastY = e.clientY;
    lastT = e.timeStamp;
    moved = false;
    spin = 0;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointer) return;
    if (!moved && Math.hypot(e.clientX - downX, e.clientY - downY) < 6) return;
    if (!moved) {
      moved = true;
      dragging = true;
      canvas.style.cursor = 'grabbing';
      if (focusId) opts.onPick(null);
    }
    const k = 1 / pxPerRadian();
    const dx = (e.clientX - lastX) * k;
    yaw += dx;
    pitch = Math.min(1.2, Math.max(-1.2, pitch + (e.clientY - lastY) * k));
    const dt = Math.max(1, e.timeStamp - lastT) / 1000;
    spin = 0.6 * spin + 0.4 * (dx / dt);
    lastX = e.clientX;
    lastY = e.clientY;
    lastT = e.timeStamp;
  });
  const release = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    pointer = null;
    dragging = false;
    canvas.style.cursor = '';
    touchedAt = performance.now();
    if (moved || e.type === 'pointercancel') return;
    const box = canvas.getBoundingClientRect();
    const x = e.clientX - box.left;
    const y = e.clientY - box.top;
    let best: string | null = null;
    let near = 52;
    flights.forEach((f) => {
      const d = Math.hypot(f.anchor.x - x, f.anchor.y + 14 - y);
      if (!f.anchor.hidden && d < near) {
        near = d;
        best = f.id;
      }
    });
    opts.onPick(best);
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  // ---- frame
  const P = new THREE.Vector3();
  const C = new THREE.Vector3();
  const ray = new THREE.Vector3();
  const list: GlobeAnchor[] = [];
  let frame = 0;
  let then = performance.now();
  let onScreen = true;
  let drift = 0;

  const draw = (now: number) => {
    frame = 0;
    const dt = Math.min(0.05, (now - then) / 1000);
    then = now;
    const snap = opts.reducedMotion;
    const ease = (k: number) => (snap ? 1 : 1 - Math.exp(-k * dt));
    let wantDist = overview();
    let wantLift = 0;

    const focused = focusId ? flights.get(focusId) : undefined;
    if (focused && !dragging) {
      const p = focused.plane.position;
      const r = p.length();
      const size = Math.min(230, Math.max(120, width * 0.34));
      const depth = (PLANES[focused.kind].L * height) / (2 * TAN * size);
      wantDist = depth + r * Math.cos(FOCUS_TILT);
      wantLift =
        -r * Math.sin(FOCUS_TILT) - (1 - (2 * focusY) / height) * depth * TAN;
      const wantYaw = wrapNear(-Math.PI / 2 - Math.atan2(-p.z, p.x), yaw);
      yaw += (wantYaw - yaw) * ease(4.5);
      pitch += (Math.asin(p.y / r) + FOCUS_TILT - pitch) * ease(4.5);
      spin = 0;
    } else if (!dragging) {
      // North stays up: a tilt from a drag or a focus settles back.
      pitch += (homePitch - pitch) * ease(1.6);
      if (Math.abs(spin) > 0.02) {
        yaw += spin * dt;
        spin *= Math.exp(-2.4 * dt);
        touchedAt = now;
      } else if (now - touchedAt > IDLE_MS || !Number.isFinite(touchedAt)) {
        // Left alone: back to the flights, swaying slowly either side.
        if (!snap) drift += dt;
        const want = wrapNear(homeYaw, yaw) + SWAY * Math.sin(drift * 0.12);
        yaw += (want - yaw) * ease(0.9);
      }
    }
    dist += (wantDist - dist) * ease(4.5);
    lift += (wantLift - lift) * ease(4.5);
    if (!snap) {
      clouds.rotation.y += dt * 0.012;
      cloudShade.rotation.y = clouds.rotation.y - 0.03;
    }

    world.rotation.set(pitch, yaw, 0);
    camera.position.set(0, lift, dist);
    camera.lookAt(0, lift, 0);
    world.updateMatrixWorld();
    camera.updateMatrixWorld();
    renderer.render(scene, camera);

    list.length = 0;
    C.copy(camera.position);
    flights.forEach((f) => {
      P.set(0, PLANES[f.kind].L * 0.22, 0);
      f.plane.localToWorld(P);
      ray.subVectors(P, C);
      const t = -C.dot(ray) / ray.lengthSq();
      const behind =
        t > 0 && t < 1 && C.clone().addScaledVector(ray, t).length() < 0.99;
      P.project(camera);
      f.anchor.x = (P.x * 0.5 + 0.5) * width;
      f.anchor.y = (-P.y * 0.5 + 0.5) * height;
      f.anchor.hidden =
        behind ||
        f.anchor.x < -20 ||
        f.anchor.x > width + 20 ||
        f.anchor.y < -20 ||
        f.anchor.y > height + 40;
      list.push(f.anchor);
    });
    opts.onFrame(list);
    if (live && onScreen && !document.hidden)
      frame = requestAnimationFrame(draw);
  };
  const wake = () => {
    if (!live || frame || !onScreen || document.hidden) return;
    then = performance.now();
    frame = requestAnimationFrame(draw);
  };

  const resize = new ResizeObserver(() => {
    width = Math.max(1, host.clientWidth);
    height = Math.max(1, host.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (!placed) dist = overview();
    wake();
  });
  resize.observe(host);
  const seen = new IntersectionObserver(([entry]) => {
    onScreen = entry?.isIntersecting ?? true;
    wake();
  });
  seen.observe(host);
  document.addEventListener('visibilitychange', wake);
  wake();
  return api;
}
