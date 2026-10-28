'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  CoinTracesSchema,
  coinGesture,
  sampleCoinTrace,
  type CoinTrace,
} from '@/lib/coin-motion';
import { useSound } from '@/lib/use-sound';
import { StaticCoin } from './StaticCoin';
import type { CoinSceneProps } from './CoinStage';

export function CoinScene(props: CoinSceneProps) {
  const host = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  const [failed, setFailed] = useState(false);
  const { playbackId, onComplete } = props;
  const { sfx, vibrate } = useSound();
  useEffect(() => {
    current.current = props;
  }, [props]);
  useEffect(() => {
    if (failed && playbackId) onComplete();
  }, [failed, playbackId, onComplete]);

  useEffect(() => {
    if (failed || !host.current) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch {
      // GPU capability is only knowable after mounting the native renderer.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFailed(true);
      return;
    }
    const mount = host.current;
    let disposed = false;
    let request = 0;
    let dirty = true;
    const abort = new AbortController();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x0a0a0a);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    const canvas = renderer.domElement;
    canvas.className = 'h-full w-full touch-pan-y';
    canvas.setAttribute('aria-hidden', 'true');
    mount.appendChild(canvas);
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0a0a0a, 10, 18);
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 40);
    camera.position.set(0, 3.4, 4.2);
    camera.lookAt(0, 1.1, 0);
    const room = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromScene(room, 0.04);
    scene.environment = environment.texture;
    room.dispose();
    pmrem.dispose();
    scene.add(new THREE.HemisphereLight(0xe9f1ff, 0x272421, 0.8));
    const light = new THREE.DirectionalLight(0xffffff, 4);
    light.position.set(-3, 7, 4);
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.camera.left = -4;
    light.shadow.camera.right = 4;
    light.shadow.camera.top = 5;
    light.shadow.camera.bottom = -4;
    light.shadow.normalBias = 0.015;
    scene.add(light);
    const fill = new THREE.DirectionalLight(0xcbdcff, 2);
    fill.position.set(4, 3, -3);
    scene.add(fill);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({
        color: 0x050506,
        roughness: 0.98,
        envMapIntensity: 0.1,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.position.y = -0.006;
    scene.add(floor);
    const coin = new THREE.Group();
    scene.add(coin);
    const metal = new THREE.MeshStandardMaterial({
      color: 0xaab0b6,
      metalness: 0.95,
      roughness: 0.26,
    });
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.72, 0.72, 0.13, 96),
      metal,
    );
    body.castShadow = true;
    coin.add(body);
    const faceMaterials: THREE.MeshStandardMaterial[] = [];
    const textures: THREE.Texture[] = [];
    for (const side of [1, -1]) {
      const material = new THREE.MeshStandardMaterial({
        color: 0x222428,
        metalness: 0.83,
        roughness: 0.4,
      });
      faceMaterials.push(material);
      const face = new THREE.Mesh(
        new THREE.CircleGeometry(0.653, 96),
        material,
      );
      face.rotation.x = (side * -Math.PI) / 2;
      face.position.y = side * 0.066;
      coin.add(face);
      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(0.684, 0.022, 10, 96),
        metal,
      );
      rim.rotation.x = Math.PI / 2;
      rim.position.y = side * 0.052;
      coin.add(rim);
    }
    const reeds = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.016, 0.094, 0.012),
      metal,
      96,
    );
    const transform = new THREE.Object3D();
    for (let i = 0; i < 96; i++) {
      const a = (i * Math.PI * 2) / 96;
      transform.position.set(Math.sin(a) * 0.719, 0, Math.cos(a) * 0.719);
      transform.rotation.y = a;
      transform.updateMatrix();
      reeds.setMatrixAt(i, transform.matrix);
    }
    coin.add(reeds);
    const logo = new Image();
    logo.onload = () => {
      if (disposed) return;
      faceMaterials.forEach((material, i) => {
        const textureCanvas = document.createElement('canvas');
        textureCanvas.width = textureCanvas.height = 512;
        const ctx = textureCanvas.getContext('2d');
        if (!ctx) return;
        ctx.fillStyle = '#141619';
        ctx.fillRect(0, 0, 512, 512);
        // Seeded micrograin gives satin titanium its changing highlights.
        let seed = 23;
        for (let j = 0; j < 12000; j++) {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          const x = (seed >>> 16) % 512;
          seed = (seed * 1664525 + 1013904223) >>> 0;
          ctx.fillStyle = j % 2 ? '#ffffff08' : '#00000018';
          ctx.fillRect(x, (seed >>> 16) % 512, 1, 1);
        }
        const bumpCanvas = document.createElement('canvas');
        bumpCanvas.width = bumpCanvas.height = 512;
        const bump = bumpCanvas.getContext('2d');
        if (!bump) return;
        bump.fillStyle = '#000';
        bump.fillRect(0, 0, 512, 512);
        for (const context of [ctx, bump]) {
          if (i === 0)
            context.drawImage(logo, 0, 0, 60, 90, 158, 108, 196, 294);
          else context.drawImage(logo, 0, 0, 368, 100, 62, 204, 388, 105);
        }
        const texture = new THREE.CanvasTexture(textureCanvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        const bumpTexture = new THREE.CanvasTexture(bumpCanvas);
        textures.push(texture, bumpTexture);
        material.color.set(0xffffff);
        material.map = texture;
        material.bumpMap = bumpTexture;
        material.bumpScale = 0.018;
        material.needsUpdate = true;
      });
      dirty = true;
    };
    logo.onerror = () => {
      if (!disposed) setFailed(true);
    };
    logo.src = '/branding/polycards-logo.png';
    let traces: CoinTrace[] = [];
    fetch('/coin-flip/motion.json', { signal: abort.signal })
      .then((r) => {
        if (!r.ok) throw new Error('Motion unavailable');
        return r.json();
      })
      .then((data) => {
        traces = CoinTracesSchema.parse(data);
        dirty = true;
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    const initial = new THREE.Quaternion(Math.sin(0.32), 0, 0, Math.cos(0.32));
    coin.position.set(0, 1, 0);
    coin.quaternion.copy(initial);
    const a = new THREE.Quaternion();
    const b = new THREE.Quaternion();
    let startedAt = 0;
    let playedId: string | null = null;
    let lastState = '';
    let impact = 0;
    let active: CoinTrace | undefined;
    let offset = 0;
    let drag: {
      id: number;
      x: number;
      y: number;
      samples: { x: number; y: number; t: number }[];
    } | null = null;
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const down = (e: PointerEvent) => {
      if (!current.current.armed || e.button !== 0 || drag || !traces.length)
        return;
      const rect = canvas.getBoundingClientRect();
      pointer.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        (-(e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      if (!raycaster.intersectObject(coin, true).length) return;
      canvas.setPointerCapture(e.pointerId);
      drag = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        samples: [{ x: e.clientX, y: e.clientY, t: performance.now() }],
      };
    };
    const move = (e: PointerEvent) => {
      if (!drag || drag.id !== e.pointerId) return;
      const now = performance.now();
      drag.samples.push({ x: e.clientX, y: e.clientY, t: now });
      while (drag.samples.length > 2 && now - drag.samples[0]!.t > 150)
        drag.samples.shift();
      coin.position.x = Math.max(
        -0.65,
        Math.min(0.65, (e.clientX - drag.x) / 150),
      );
      coin.position.y =
        1 + Math.max(-0.2, Math.min(0.4, (drag.y - e.clientY) / 400));
      dirty = true;
    };
    const release = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const start = drag.samples[0]!;
      const profile =
        e.type === 'pointerup'
          ? coinGesture(
              e.clientX - start.x,
              e.clientY - start.y,
              performance.now() - start.t,
            )
          : null;
      offset = profile ? coin.position.x : 0;
      drag = null;
      coin.position.set(offset, 1, 0);
      dirty = true;
      if (profile && current.current.armed) current.current.onFlick(profile);
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('lostpointercapture', release);
    const contextLost = (e: Event) => {
      e.preventDefault();
      setFailed(true);
    };
    canvas.addEventListener('webglcontextlost', contextLost);
    const resize = () => {
      const { width, height } = mount.getBoundingClientRect();
      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix();
      dirty = true;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();
    const tick = (now: number) => {
      if (disposed) return;
      const p = current.current;
      const state = `${p.outcome}/${p.playbackId}/${p.armed}`;
      if (state !== lastState) {
        dirty = true;
        lastState = state;
        canvas.className = p.armed
          ? 'h-full w-full touch-none'
          : 'h-full w-full touch-pan-y';
      }
      if (!p.armed && drag) {
        drag = null;
        coin.position.set(0, 1, 0);
      }
      if (p.playbackId && playedId !== p.playbackId && traces.length) {
        active = traces.find(
          (t) => t.won === (p.outcome === 'won') && t.profile === p.profile,
        );
        playedId = p.playbackId;
        startedAt = now;
        impact = 0;
      }
      if (active && p.playbackId) {
        const seconds = (now - startedAt) / 1000;
        const f = sampleCoinTrace(active, seconds);
        coin.position.set(
          THREE.MathUtils.lerp(f.a[0], f.b[0], f.alpha) + offset,
          THREE.MathUtils.lerp(f.a[1], f.b[1], f.alpha),
          THREE.MathUtils.lerp(f.a[2], f.b[2], f.alpha),
        );
        a.fromArray(f.a, 3);
        b.fromArray(f.b, 3);
        coin.quaternion.copy(a).slerp(b, f.alpha);
        if (
          impact < active.impacts.length &&
          seconds >= active.impacts[impact]!
        ) {
          sfx(impact === 0 ? 'thunk' : 'clack');
          if (impact === 0) vibrate(12);
          impact++;
        }
        dirty = true;
        if (seconds >= (active.frames.length - 1) / active.fps) {
          active = undefined;
          p.onComplete();
        }
      } else if (dirty && !drag) {
        if (p.outcome) {
          const f = traces
            .find(
              (t) => t.won === (p.outcome === 'won') && t.profile === p.profile,
            )
            ?.frames.at(-1);
          if (f) {
            coin.position.set(f[0] + offset, f[1], f[2]);
            coin.quaternion.fromArray(f, 3);
          }
        } else {
          coin.position.set(offset, 1, 0);
          coin.quaternion.copy(initial);
        }
      }
      if (dirty && !document.hidden) {
        renderer.render(scene, camera);
        dirty = false;
      }
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => {
      disposed = true;
      abort.abort();
      cancelAnimationFrame(request);
      observer.disconnect();
      canvas.removeEventListener('webglcontextlost', contextLost);
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', release);
      canvas.removeEventListener('pointercancel', release);
      canvas.removeEventListener('lostpointercapture', release);
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          for (const material of Array.isArray(object.material)
            ? object.material
            : [object.material])
            material.dispose();
        }
      });
      textures.forEach((t) => t.dispose());
      environment.dispose();
      light.shadow.dispose();
      renderer.dispose();
      canvas.remove();
    };
  }, [failed, sfx, vibrate]);
  return failed ? (
    <div className="flex h-64 items-center justify-center bg-neutral-950 sm:h-96">
      <StaticCoin won={props.outcome !== 'lost'} />
    </div>
  ) : (
    <div
      ref={host}
      role="img"
      aria-label="Black titanium coin. Use the Flip coin button or flick the coin upward."
      className="h-64 w-full overflow-hidden bg-neutral-950 sm:h-96"
    />
  );
}
