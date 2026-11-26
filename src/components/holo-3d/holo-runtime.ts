import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PLAY_SECONDS, actionPose, type HoloKind } from './holo-pose';

export type HoloOptions = {
  kind: HoloKind;
  /** The wire cube, floor rings and scan line around the object. Off for
   *  small sizes, where they would only be noise. */
  cage: boolean;
  /** Whether the canvas takes the pointer: drag to turn, tap to play. */
  interactive: boolean;
  /** The first frame with the model in it has been drawn. */
  onReady: () => void;
};

export type HoloHandle = { dispose: () => void };

/** The cube's side; the model is scaled to 2 across. */
const CAGE = 2.5;
const WHITE = 0xffffff;

/** A soft white disc, for the light behind the object. */
function haloTexture(): THREE.CanvasTexture {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const fill = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  fill.addColorStop(0, 'rgba(255,255,255,1)');
  fill.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  fill.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = fill;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

const line = (opacity: number) =>
  new THREE.LineBasicMaterial({
    color: WHITE,
    transparent: true,
    opacity,
    depthWrite: false,
  });

function segments(points: number[], opacity: number): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(points, 3),
  );
  return new THREE.LineSegments(geometry, line(opacity));
}

/** The hologram stand: a faint cube, bright corners, floor rings with ticks,
 *  a scan line and a few rising motes. */
function buildCage() {
  const group = new THREE.Group();
  const h = CAGE / 2;

  const box = new THREE.BoxGeometry(CAGE, CAGE, CAGE);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(box),
    line(0.14),
  );
  box.dispose();
  group.add(edges);

  // Three short strokes at each corner.
  const corner: number[] = [];
  const len = 0.3;
  for (const x of [-h, h])
    for (const y of [-h, h])
      for (const z of [-h, h]) {
        corner.push(x, y, z, x - Math.sign(x) * len, y, z);
        corner.push(x, y, z, x, y - Math.sign(y) * len, z);
        corner.push(x, y, z, x, y, z - Math.sign(z) * len);
      }
  group.add(segments(corner, 0.9));

  // The floor: two rings and a dial of ticks.
  const floor: number[] = [];
  const ring = (r: number, steps: number) => {
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const b = ((i + 1) / steps) * Math.PI * 2;
      floor.push(r * Math.cos(a), -h, r * Math.sin(a));
      floor.push(r * Math.cos(b), -h, r * Math.sin(b));
    }
  };
  ring(0.78, 64);
  ring(1.08, 64);
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    const far = i % 3 === 0 ? 1.2 : 1.14;
    floor.push(1.08 * Math.cos(a), -h, 1.08 * Math.sin(a));
    floor.push(far * Math.cos(a), -h, far * Math.sin(a));
  }
  const dial = segments(floor, 0.42);
  group.add(dial);

  const scan = segments(
    [
      -h,
      0,
      -h,
      h,
      0,
      -h,
      h,
      0,
      -h,
      h,
      0,
      h,
      h,
      0,
      h,
      -h,
      0,
      h,
      -h,
      0,
      h,
      -h,
      0,
      -h,
    ],
    0.5,
  );
  group.add(scan);

  const count = 18;
  const seed = Float32Array.from({ length: count * 3 }, () => Math.random());
  const motes = new THREE.BufferGeometry();
  motes.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(count * 3), 3),
  );
  const dots = new THREE.Points(
    motes,
    new THREE.PointsMaterial({
      color: WHITE,
      size: 0.04,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    }),
  );
  group.add(dots);

  const update = (t: number, glow: number) => {
    group.rotation.y = 0.55 + Math.sin(t * 0.25) * 0.22;
    dial.rotation.y = t * 0.2;
    const sweep = (t * 0.28) % 1;
    scan.position.y = -h + sweep * CAGE;
    (scan.material as THREE.LineBasicMaterial).opacity =
      Math.sin(Math.PI * sweep) * (0.45 + glow * 0.4);
    const position = motes.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < count; i++) {
      const rise =
        (seed[i * 3 + 1]! + t * (0.05 + seed[i * 3]! * 0.07) * (1 + glow * 3)) %
        1;
      position.setXYZ(
        i,
        (seed[i * 3]! - 0.5) * CAGE * 0.86,
        -h + rise * CAGE,
        (seed[i * 3 + 2]! - 0.5) * CAGE * 0.86,
      );
    }
    position.needsUpdate = true;
  };
  return { group, update };
}

/**
 * Draws one icon into `canvas` and runs it: an idle float and turn, a tilt
 * towards the mouse, a drag to turn it and a tap to play its move
 * (holo-pose.ts). Returns null when WebGL is not there; the poster under the
 * canvas then stays. The loop runs only while the canvas is on screen in a
 * visible tab.
 */
export function mountHolo(
  canvas: HTMLCanvasElement,
  { kind, cage, interactive, onReady }: HoloOptions,
): HoloHandle | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
    });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;

  const scene = new THREE.Scene();
  // Glossy black shows only what it reflects: a lit room, then two lamps for
  // the edge lights.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04).texture;
  scene.environment = environment;
  const key = new THREE.DirectionalLight(WHITE, 2.4);
  key.position.set(-2.5, 4, 3.5);
  const rim = new THREE.DirectionalLight(WHITE, 3.2);
  rim.position.set(3, 2.5, -4);
  scene.add(key, rim);

  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
  camera.position.set(0, cage ? 1.5 : 1, cage ? 8.2 : 6.4);
  camera.lookAt(0, 0, 0);

  const materials = {
    body: new THREE.MeshPhysicalMaterial({
      color: 0x0b0b0d,
      metalness: 0.55,
      roughness: 0.3,
      clearcoat: 1,
      clearcoatRoughness: 0.14,
      envMapIntensity: 1.7,
    }),
    trim: new THREE.MeshStandardMaterial({
      color: 0x4a4b50,
      metalness: 1,
      roughness: 0.2,
      envMapIntensity: 1.9,
    }),
    glow: new THREE.MeshBasicMaterial({ color: WHITE, toneMapped: false }),
  };

  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: haloTexture(),
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
    }),
  );
  halo.position.set(0, 0, -1.6);
  halo.scale.setScalar(cage ? 4.6 : 4);
  scene.add(halo);

  // rig tilts towards the mouse; turn carries the idle spin and the drag.
  const rig = new THREE.Group();
  const turn = new THREE.Group();
  rig.add(turn);
  scene.add(rig);
  const stand = cage ? buildCage() : null;
  if (stand) rig.add(stand.group);

  let disposed = false;
  let model: THREE.Object3D | null = null;
  let lid: THREE.Object3D | null = null;
  let door: THREE.Object3D | null = null;
  let wheel: THREE.Object3D | null = null;
  let lidY = 0;

  new GLTFLoader().load(
    `/3dicons/${kind}.glb`,
    (gltf) => {
      if (disposed) return;
      const loaded = gltf.scene;
      loaded.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return;
        const old = node.material as THREE.Material;
        node.material =
          materials[old.name as keyof typeof materials] ?? materials.body;
        old.dispose();
      });
      // Centred, 2 across.
      const bounds = new THREE.Box3().setFromObject(loaded);
      const size = bounds.getSize(new THREE.Vector3());
      loaded.position.sub(bounds.getCenter(new THREE.Vector3()));
      const fit = new THREE.Group();
      fit.scale.setScalar(2 / Math.max(size.x, size.y, size.z));
      fit.add(loaded);
      turn.add(fit);
      lid = loaded.getObjectByName('lid') ?? null;
      door = loaded.getObjectByName('door') ?? null;
      wheel = loaded.getObjectByName('wheel') ?? null;
      lidY = lid?.position.y ?? 0;
      model = fit;
    },
    undefined,
    () => {},
  );

  // --- pointer -------------------------------------------------------------
  const aim = { x: 0, y: 0 };
  let down = false;
  let lastX = 0;
  let travelled = 0;
  let yaw = 0;
  let yawSpeed = 0;
  let played = -1;

  const onWindowMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    const box = canvas.getBoundingClientRect();
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    aim.x = clamp(
      (e.clientX - (box.left + box.width / 2)) / (window.innerWidth / 2),
    );
    aim.y = clamp(
      (e.clientY - (box.top + box.height / 2)) / (window.innerHeight / 2),
    );
  };
  const onDown = (e: PointerEvent) => {
    down = true;
    lastX = e.clientX;
    travelled = 0;
    canvas.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!down) return;
    const dx = e.clientX - lastX;
    lastX = e.clientX;
    travelled += Math.abs(dx);
    yawSpeed = dx * 0.012;
    yaw += yawSpeed;
  };
  const onUp = () => {
    if (down && travelled < 6 && played < 0) played = 0;
    down = false;
  };
  const onCancel = () => {
    down = false;
  };
  window.addEventListener('pointermove', onWindowMove, { passive: true });
  if (interactive) {
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
  }

  // --- loop ----------------------------------------------------------------
  const clock = new THREE.Clock();
  let t = 0;
  let request = 0;
  let ready = false;
  const frame = () => {
    request = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    t += dt;
    if (played >= 0) {
      played += dt / PLAY_SECONDS[kind];
      if (played >= 1) played = -1;
    }
    const pose = actionPose(kind, played);

    if (!down) {
      yaw += yawSpeed;
      yawSpeed *= 0.94;
      // The vault has a front: it swings back to it.
      if (kind === 'vault') yaw *= 0.93;
    }
    const idle = kind === 'vault' ? Math.sin(t * 0.7) * 0.38 : 0.6 + t * 0.5;
    turn.rotation.y = idle + yaw + pose.turn;
    turn.position.y = Math.sin(t * 1.3) * 0.05 + pose.hop * 0.28;
    rig.rotation.x += (aim.y * 0.22 - rig.rotation.x) * 0.08;
    rig.rotation.y += (aim.x * 0.3 - rig.rotation.y) * 0.08;

    if (lid) {
      lid.position.y = lidY + pose.lid * 0.6;
      lid.rotation.set(-pose.lid * 0.38, pose.lid * 0.5, 0);
    }
    if (wheel) wheel.rotation.z = -pose.wheel;
    if (door) door.rotation.y = -pose.door * 1.2;
    halo.material.opacity = 0.16 + pose.glow * 0.3;
    stand?.update(t, pose.glow);

    renderer.render(scene, camera);
    if (!ready && model) {
      ready = true;
      onReady();
    }
  };

  let onScreen = false;
  const sync = () => {
    const run = onScreen && !document.hidden;
    if (run && !request) {
      clock.getDelta();
      request = requestAnimationFrame(frame);
    } else if (!run && request) {
      cancelAnimationFrame(request);
      request = 0;
    }
  };
  const seen = new IntersectionObserver((entries) => {
    onScreen = entries.some((e) => e.isIntersecting);
    sync();
  });
  seen.observe(canvas);
  document.addEventListener('visibilitychange', sync);

  const fit = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const sized = new ResizeObserver(fit);
  sized.observe(canvas);
  fit();

  return {
    dispose() {
      disposed = true;
      cancelAnimationFrame(request);
      seen.disconnect();
      sized.disconnect();
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('pointermove', onWindowMove);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      scene.traverse((node) => {
        if (
          node instanceof THREE.Mesh ||
          node instanceof THREE.LineSegments ||
          node instanceof THREE.Points
        ) {
          node.geometry.dispose();
          // Meshes share `materials`, freed below; each line owns its own.
          if (!(node instanceof THREE.Mesh))
            (node.material as THREE.Material).dispose();
        }
      });
      for (const material of Object.values(materials)) material.dispose();
      halo.material.map?.dispose();
      halo.material.dispose();
      room.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          node.geometry.dispose();
          (node.material as THREE.Material).dispose();
        }
      });
      environment.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
