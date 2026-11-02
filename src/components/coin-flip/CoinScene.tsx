'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  CoinTracesSchema,
  COIN_CAMERA,
  COIN_REVEAL_HOLD,
  COIN_TABLE_Y,
  coinCameraPath,
  coinGesture,
  coinSoundEvents,
  coinTraceFor,
  sampleCoinCamera,
  sampleCoinTrace,
  type CoinCameraFrame,
  type CoinSoundEvent,
  type CoinTrace,
} from '@/lib/coin-motion';
import { useSound } from '@/lib/use-sound';
import type { CoinSceneProps } from './CoinStage';

export function CoinScene(props: CoinSceneProps) {
  const host = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  const [failed, setFailed] = useState(false);
  const { onReadyChange } = props;
  const { sfx, vibrate } = useSound();
  useEffect(() => {
    current.current = props;
  }, [props]);
  useEffect(() => {
    if (failed) onReadyChange(false);
  }, [failed, onReadyChange]);

  useEffect(() => {
    if (failed || !host.current) return;
    current.current.onReadyChange(false);
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
    let logoReady = false;
    let assetsReady = false;
    let readyReported = false;
    let traces: CoinTrace[] = [];
    const reportReady = () => {
      assetsReady = logoReady && traces.length > 0;
      dirty = true;
    };
    const abort = new AbortController();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x0a0a0a);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    const canvas = renderer.domElement;
    canvas.className = 'h-full w-full touch-pan-y';
    canvas.setAttribute('aria-hidden', 'true');
    mount.appendChild(canvas);
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0a0a0a, 10, 18);
    const camera = new THREE.PerspectiveCamera(COIN_CAMERA.fov, 1, 0.1, 40);
    camera.position.set(0, 2.5, 2.7);
    const cameraAim = new THREE.Vector3(0, 1, 0);
    const cameraDestination = new THREE.Vector3();
    const aimDestination = new THREE.Vector3();
    camera.lookAt(cameraAim);
    // Broad studio reflections reveal the bevel and brushing as the coin turns.
    const studio = new THREE.Scene();
    studio.background = new THREE.Color(0x606468);
    for (const [x, y, z, width, height, intensity] of [
      [-1.5, 6, 1.5, 5, 4, 4],
      [4, 2, 1, 1.2, 5, 3],
      [0, 4, -5, 4, 2, 4],
    ] as const) {
      const softbox = new THREE.Mesh(
        new THREE.PlaneGeometry(width, height),
        new THREE.MeshBasicMaterial({
          color: new THREE.Color().setScalar(intensity),
        }),
      );
      softbox.position.set(x, y, z);
      softbox.lookAt(0, 0, 0);
      studio.add(softbox);
    }
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromScene(studio, 0.025);
    scene.environment = environment.texture;
    studio.children.forEach((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        object.material.dispose();
      }
    });
    pmrem.dispose();
    scene.add(new THREE.HemisphereLight(0xf1f0ed, 0x101012, 0.25));
    const light = new THREE.DirectionalLight(0xffffff, 2.7);
    light.position.set(-3, 7, 4);
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.camera.left = -4;
    light.shadow.camera.right = 4;
    light.shadow.camera.top = 5;
    light.shadow.camera.bottom = -4;
    light.shadow.normalBias = 0.015;
    scene.add(light);
    const fill = new THREE.DirectionalLight(0xe3e8ed, 1.1);
    fill.position.set(4, 3, -3);
    scene.add(fill);
    // A soft pool of light on the table lets the shadow and each bounce read.
    const pool = document.createElement('canvas');
    pool.width = pool.height = 256;
    const poolContext = pool.getContext('2d');
    if (poolContext) {
      const gradient = poolContext.createRadialGradient(
        128,
        128,
        0,
        128,
        128,
        128,
      );
      gradient.addColorStop(0, '#2b2d31');
      gradient.addColorStop(0.45, '#141518');
      gradient.addColorStop(1, '#070708');
      poolContext.fillStyle = gradient;
      poolContext.fillRect(0, 0, 256, 256);
    }
    const poolTexture = new THREE.CanvasTexture(pool);
    poolTexture.colorSpace = THREE.SRGBColorSpace;
    // The pool spans the middle fifth of the floor; the edge colour fills the rest.
    poolTexture.repeat.setScalar(5);
    poolTexture.offset.setScalar(-2);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        map: poolTexture,
        roughness: 0.98,
        metalness: 0,
        // Rough dielectric reflections otherwise wash the black table gray.
        specularIntensity: 0.08,
        envMapIntensity: 0,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.position.y = COIN_TABLE_Y;
    scene.add(floor);
    // Result moment. Win: the landed face lights up, a ring of light runs out
    // across the table and a few motes rise off the coin (Lucky Draw dust
    // scale, never a shower), then everything returns to the resting look
    // within 1.2 s. Loss: the table light dims and stays dim. Credited-money
    // green and silver only; gold is for claimable prizes.
    const glow = new THREE.Color(0x7ee2a8);
    // A soft, thin halo texture: a flat ring mesh read as a grey plastic band.
    const halo = document.createElement('canvas');
    halo.width = halo.height = 256;
    const haloContext = halo.getContext('2d');
    if (haloContext) {
      const band = haloContext.createRadialGradient(128, 128, 0, 128, 128, 128);
      band.addColorStop(0, '#ffffff00');
      band.addColorStop(0.8, '#ffffff00');
      band.addColorStop(0.9, '#ffffff');
      band.addColorStop(1, '#ffffff00');
      haloContext.fillStyle = band;
      haloContext.fillRect(0, 0, 256, 256);
    }
    const haloTexture = new THREE.CanvasTexture(halo);
    const ring = new THREE.Mesh(
      new THREE.PlaneGeometry(1.8, 1.8),
      new THREE.MeshBasicMaterial({
        map: haloTexture,
        color: 0x5fd18f,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    scene.add(ring);
    const motes = Array.from({ length: 14 }, (_, i) => ({
      angle: (i / 14) * Math.PI * 2 + Math.sin(i * 12.9898) * 0.4,
      delay: (i % 5) * 0.05,
      rise: 0.7 + (i % 3) * 0.22,
    }));
    const moteGeometry = new THREE.BufferGeometry();
    moteGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(motes.length * 3), 3),
    );
    moteGeometry.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array(motes.length * 3), 3),
    );
    const dot = document.createElement('canvas');
    dot.width = dot.height = 32;
    const dotContext = dot.getContext('2d');
    if (dotContext) {
      const fade = dotContext.createRadialGradient(16, 16, 0, 16, 16, 16);
      fade.addColorStop(0, '#ffffff');
      fade.addColorStop(0.35, '#ffffffaa');
      fade.addColorStop(1, '#ffffff00');
      dotContext.fillStyle = fade;
      dotContext.fillRect(0, 0, 32, 32);
    }
    const dotTexture = new THREE.CanvasTexture(dot);
    const moteMaterial = new THREE.PointsMaterial({
      size: 0.07,
      map: dotTexture,
      color: 0xd9fbe7,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const moteCloud = new THREE.Points(moteGeometry, moteMaterial);
    moteCloud.visible = false;
    moteCloud.frustumCulled = false;
    scene.add(moteCloud);
    // Present from the start at zero intensity: adding a light later would
    // recompile every material at the reveal.
    const glint = new THREE.PointLight(0xeafff2, 0, 2.5, 2);
    scene.add(glint);
    let revealedAt: number | null = null;
    const coin = new THREE.Group();
    scene.add(coin);
    // Anisotropy stretches the studio reflections along the metal's brushing.
    // https://threejs.org/docs/pages/MeshPhysicalMaterial.html
    const metal = new THREE.MeshPhysicalMaterial({
      color: 0x959a9f,
      metalness: 1,
      roughness: 0.23,
      anisotropy: 0.35,
    });
    const edge = new THREE.MeshPhysicalMaterial({
      color: 0x454a4e,
      metalness: 1,
      roughness: 0.3,
      anisotropy: 0.5,
    });
    const body = new THREE.Mesh(
      new THREE.LatheGeometry(
        [
          [0.001, -0.065],
          [0.65, -0.065],
          [0.699, -0.061],
          [0.718, -0.046],
          [0.72, -0.032],
          [0.72, 0.032],
          [0.718, 0.046],
          [0.699, 0.061],
          [0.65, 0.065],
          [0.001, 0.065],
        ].map(([radius, height]) => new THREE.Vector2(radius, height)),
        128,
      ),
      edge,
    );
    body.castShadow = true;
    coin.add(body);
    const faceMaterials: THREE.MeshStandardMaterial[] = [];
    const textures: THREE.Texture[] = [];
    for (const side of [1, -1]) {
      const material = new THREE.MeshPhysicalMaterial({
        color: 0x282b2e,
        metalness: 0.8,
        roughness: 0.4,
        anisotropy: 0.5,
      });
      faceMaterials.push(material);
      const face = new THREE.Mesh(
        new THREE.CircleGeometry(0.659, 96),
        material,
      );
      face.rotation.x = (side * -Math.PI) / 2;
      face.position.y = side * 0.066;
      coin.add(face);
      const rim = new THREE.Mesh(
        new THREE.LatheGeometry(
          [
            [0.717, 0.04],
            [0.706, 0.056],
            [0.687, 0.069],
            [0.664, 0.069],
            [0.657, 0.066],
          ].map(([radius, height]) => new THREE.Vector2(radius, height)),
          128,
        ),
        metal,
      );
      rim.rotation.x = side === 1 ? 0 : Math.PI;
      coin.add(rim);
      const engraving = new THREE.Mesh(
        new THREE.TorusGeometry(0.626, 0.0022, 6, 128),
        edge,
      );
      engraving.rotation.x = Math.PI / 2;
      engraving.position.y = side * 0.067;
      coin.add(engraving);
    }
    const reeds = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.005, 0.062, 0.003),
      metal,
      144,
    );
    const transform = new THREE.Object3D();
    for (let i = 0; i < 144; i++) {
      const a = (i * Math.PI * 2) / 144;
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
        ctx.fillStyle = '#282b2e';
        ctx.fillRect(0, 0, 512, 512);
        // Seeded micrograin gives satin titanium its changing highlights.
        let seed = 23;
        for (let j = 0; j < 12000; j++) {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          const x = (seed >>> 16) % 512;
          seed = (seed * 1664525 + 1013904223) >>> 0;
          ctx.fillStyle = j % 2 ? '#ffffff0c' : '#00000018';
          ctx.fillRect(x, (seed >>> 16) % 512, 1, 1);
        }
        ctx.lineWidth = 0.45;
        for (let radius = 10; radius < 255; radius += 1.7) {
          ctx.strokeStyle = radius % 3 < 1.5 ? '#ffffff05' : '#0000000a';
          ctx.beginPath();
          ctx.arc(256, 256, radius, 0, Math.PI * 2);
          ctx.stroke();
        }
        const bumpCanvas = document.createElement('canvas');
        bumpCanvas.width = bumpCanvas.height = 512;
        const bump = bumpCanvas.getContext('2d');
        if (!bump) return;
        bump.fillStyle = '#808080';
        bump.fillRect(0, 0, 512, 512);
        bump.lineWidth = 0.6;
        bump.strokeStyle = '#8b8b8b';
        for (let radius = 6; radius < 256; radius += 1.7) {
          bump.beginPath();
          bump.arc(256, 256, radius, 0, Math.PI * 2);
          bump.stroke();
        }
        const emblem = document.createElement('canvas');
        emblem.width = emblem.height = 512;
        const silver = emblem.getContext('2d');
        if (!silver) return;
        for (const context of [silver, bump]) {
          if (i === 0)
            context.drawImage(logo, 0, 0, 60, 90, 158, 108, 196, 294);
          else context.drawImage(logo, 90, 20, 278, 70, 64, 208, 384, 97);
          context.font = '600 28px sans-serif';
          context.textAlign = 'center';
          context.fillStyle = '#fff';
          context.fillText(i === 0 ? 'Head' : 'Tail', 256, 448);
        }
        silver.globalCompositeOperation = 'source-in';
        silver.fillStyle = '#b0b4b7';
        silver.fillRect(0, 0, 512, 512);
        ctx.drawImage(emblem, 0, 0);
        const roughCanvas = document.createElement('canvas');
        roughCanvas.width = roughCanvas.height = 512;
        const rough = roughCanvas.getContext('2d');
        if (!rough) return;
        rough.fillStyle = '#adadad';
        rough.fillRect(0, 0, 512, 512);
        silver.fillStyle = '#c2c2c2';
        silver.fillRect(0, 0, 512, 512);
        rough.drawImage(emblem, 0, 0);
        const texture = new THREE.CanvasTexture(textureCanvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        const bumpTexture = new THREE.CanvasTexture(bumpCanvas);
        const roughTexture = new THREE.CanvasTexture(roughCanvas);
        for (const map of [texture, bumpTexture, roughTexture])
          map.anisotropy = Math.min(
            4,
            renderer.capabilities.getMaxAnisotropy(),
          );
        textures.push(texture, bumpTexture, roughTexture);
        material.color.set(0xffffff);
        material.map = texture;
        material.bumpMap = bumpTexture;
        material.bumpScale = 0.012;
        material.roughness = 0.6;
        material.roughnessMap = roughTexture;
        // Black emissive adds nothing; the win lights the emblem through it.
        material.emissiveMap = texture;
        material.emissive.set(0x000000);
        material.needsUpdate = true;
      });
      logoReady = true;
      reportReady();
    };
    logo.onerror = () => {
      if (!disposed) setFailed(true);
    };
    logo.src = '/branding/polycards-logo.png';
    fetch('/coin-flip/motion.json', { signal: abort.signal })
      .then((r) => {
        if (!r.ok) throw new Error('Motion unavailable');
        return r.json();
      })
      .then((data) => {
        if (disposed) return;
        traces = CoinTracesSchema.parse(data);
        reportReady();
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    const initial = new THREE.Quaternion(Math.sin(0.32), 0, 0, Math.cos(0.32));
    // Half a turn about X shows the other face.
    const faceFlip = new THREE.Quaternion(1, 0, 0, 0);
    coin.position.set(0, 1, 0);
    coin.quaternion.copy(initial);
    const a = new THREE.Quaternion();
    const b = new THREE.Quaternion();
    const goalPosition = new THREE.Vector3(0, 1, 0);
    const goalRotation = new THREE.Quaternion();
    const tilt = new THREE.Quaternion();
    const velocity = new THREE.Vector3();
    const force = new THREE.Vector3();
    const xAxis = new THREE.Vector3(1, 0, 0);
    const zAxis = new THREE.Vector3(0, 0, 1);
    const handoffPosition = new THREE.Vector3();
    const handoffRotation = new THREE.Quaternion();
    const handoffCamera = new THREE.Vector3();
    const handoffAim = new THREE.Vector3();
    let cameraPath: CoinCameraFrame[] = [];
    let startedAt = 0;
    let playedId: string | null = null;
    let startsOnTail = false;
    let lastState = '';
    let sounds: CoinSoundEvent[] = [];
    let sound = 0;
    let active: CoinTrace | undefined;
    // Where the player let go: the throw keeps this sideways offset and lift.
    let offset = 0;
    let launchLift = 0;
    let drag: {
      id: number;
      x: number;
      y: number;
      t: number;
      dx: number;
      dy: number;
      pointerType: string;
      samples: { x: number; y: number; t: number }[];
    } | null = null;
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const onCoin = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      pointer.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        (-(clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObject(coin, true).length > 0;
    };
    // Only a touch that starts on the coin stops the page scrolling; the canvas stays
    // touch-pan-y, so one beside it scrolls. A scroll cancels its pointer, which never tosses.
    const touchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!current.current.armed || !assetsReady || !touch) return;
      if (onCoin(touch.clientX, touch.clientY)) e.preventDefault();
    };
    const down = (e: PointerEvent) => {
      if (!current.current.armed || e.button !== 0 || drag || !assetsReady)
        return;
      if (!onCoin(e.clientX, e.clientY)) return;
      e.preventDefault();
      // Capture keeps mouse movement/release attached when it leaves the coin.
      // https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture
      canvas.setPointerCapture(e.pointerId);
      const t = performance.now();
      drag = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        t,
        dx: 0,
        dy: 0,
        pointerType: e.pointerType,
        samples: [{ x: e.clientX, y: e.clientY, t }],
      };
      dirty = true;
    };
    const move = (e: PointerEvent) => {
      if (!drag || drag.id !== e.pointerId) return;
      const now = performance.now();
      drag.samples.push({ x: e.clientX, y: e.clientY, t: now });
      while (drag.samples.length > 2 && now - drag.samples[0]!.t > 150)
        drag.samples.shift();
      drag.dx = e.clientX - drag.x;
      drag.dy = e.clientY - drag.y;
      dirty = true;
    };
    const release = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const now = performance.now();
      const recent = drag.samples[0]!;
      const profile =
        e.type === 'pointerup'
          ? coinGesture(
              e.clientX - drag.x,
              e.clientY - drag.y,
              now - drag.t,
              drag.pointerType,
              now > recent.t ? (recent.y - e.clientY) / (now - recent.t) : 0,
            )
          : null;
      // A cancelled pull keeps no offset, so the spring carries it home.
      if (profile != null) {
        offset = coin.position.x;
        launchLift = coin.position.y - 1;
      }
      drag = null;
      if (canvas.hasPointerCapture(e.pointerId))
        canvas.releasePointerCapture(e.pointerId);
      dirty = true;
      if (profile != null && current.current.armed)
        current.current.onFlick(profile);
    };
    canvas.addEventListener('touchstart', touchStart, { passive: false });
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
    let previousTick = performance.now();
    const { clamp, lerp } = THREE.MathUtils;
    const tick = (now: number) => {
      if (disposed) return;
      const p = current.current;
      if (!p.outcome && !p.playbackId) startsOnTail = p.side === 'tail';
      const delta = Math.min(0.05, (now - previousTick) / 1000);
      previousTick = now;
      const state = `${p.outcome}/${p.side}/${p.playbackId}/${p.armed}/${p.pending}`;
      if (state !== lastState) {
        dirty = true;
        lastState = state;
        canvas.className = p.armed
          ? 'h-full w-full touch-pan-y cursor-grab active:cursor-grabbing'
          : 'h-full w-full touch-pan-y';
      }
      if (!p.armed && drag) {
        const id = drag.id;
        drag = null;
        if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
      }
      if (p.playbackId && playedId !== p.playbackId && assetsReady) {
        active = coinTraceFor(
          traces,
          p.side === 'head',
          p.profile,
          startsOnTail,
        );
        playedId = p.playbackId;
        startedAt = now;
        sounds = active ? coinSoundEvents(active) : [];
        sound = 0;
        handoffPosition.copy(coin.position);
        handoffRotation.copy(coin.quaternion);
        handoffCamera.copy(camera.position);
        handoffAim.copy(cameraAim);
        cameraPath = active ? coinCameraPath(active, offset) : [];
      }
      if (active && p.playbackId) {
        const seconds = (now - startedAt) / 1000;
        const f = sampleCoinTrace(active, seconds);
        goalPosition.set(
          lerp(f.a[0], f.b[0], f.alpha) + offset,
          lerp(f.a[1], f.b[1], f.alpha),
          lerp(f.a[2], f.b[2], f.alpha),
        );
        a.fromArray(f.a, 3);
        b.fromArray(f.b, 3);
        goalRotation.copy(a).slerp(b, f.alpha);
        // The symmetric coin keeps its physical trajectory when its faces swap.
        if (startsOnTail) goalRotation.multiply(faceFlip);
        // Ease out of the held pose so release lift, tilt and hover never snap.
        const blend = 1 - (1 - Math.min(1, seconds / 0.18)) ** 3;
        coin.position.lerpVectors(handoffPosition, goalPosition, blend);
        coin.quaternion.slerpQuaternions(handoffRotation, goalRotation, blend);
        while (sound < sounds.length && seconds >= sounds[sound]!.t) {
          const { t, name, amount } = sounds[sound]!;
          // A page coming back from the background is late: skip what it missed
          // rather than playing every cue at once.
          if (seconds - t < 0.12) {
            sfx(name, amount);
            if (name === 'coinClink' && amount === 1) vibrate(12);
          }
          sound++;
        }
        const view = sampleCoinCamera(cameraPath, active.fps, seconds);
        const settle = Math.min(1, seconds / 0.35);
        const follow = settle * settle * (3 - 2 * settle);
        camera.position.lerpVectors(
          handoffCamera,
          cameraDestination.set(view[0], view[1], view[2]),
          follow,
        );
        cameraAim.lerpVectors(
          handoffAim,
          aimDestination.set(view[3], view[4], view[5]),
          follow,
        );
        camera.lookAt(cameraAim);
        dirty = true;
        if (
          seconds >=
          (active.frames.length - 1) / active.fps + COIN_REVEAL_HOLD
        ) {
          active = undefined;
          velocity.set(0, 0, 0);
          p.onComplete();
        }
      } else {
        if (p.outcome) {
          if (dirty) {
            const f = coinTraceFor(
              traces,
              p.side === 'head',
              p.profile,
              startsOnTail,
            )?.frames.at(-1);
            if (f) {
              coin.position.set(f[0] + offset, f[1], f[2]);
              coin.quaternion.fromArray(f, 3);
              if (startsOnTail) coin.quaternion.multiply(faceFlip);
            }
          }
          velocity.set(0, 0, 0);
          // Move in so the landed face is readable.
          cameraDestination.set(coin.position.x, 1.9, coin.position.z + 2.4);
          aimDestination.copy(coin.position);
        } else {
          // Held, hovering or returning: a damped spring keeps every move physical.
          let stiffness = 170;
          let damping = 15;
          let hover = 0;
          if (drag) {
            goalPosition.set(
              clamp(drag.dx / 150, -0.4, 0.4),
              1 + clamp(-drag.dy / 400, -0.2, 0.4),
              0,
            );
            stiffness = 520;
            damping = 40;
          } else {
            if (!p.pending) {
              offset = 0;
              launchLift = 0;
            }
            // A live coin breathes in the hand; a resting one stays still.
            if (p.armed || p.pending) hover = Math.sin(now / 450) * 0.022;
            goalPosition.set(offset, 1 + launchLift + hover, 0);
          }
          goalRotation.copy(initial);
          if (p.side === 'tail') goalRotation.multiply(faceFlip);
          if (drag) {
            // Pulling up cocks the coin toward the player; sideways banks it.
            tilt.setFromAxisAngle(
              xAxis,
              0.32 * clamp((-drag.dy - 10) / 190, 0, 1),
            );
            goalRotation.premultiply(tilt);
            tilt.setFromAxisAngle(
              zAxis,
              -0.6 * clamp(drag.dx / 150, -0.4, 0.4),
            );
            goalRotation.premultiply(tilt);
          }
          for (let left = delta; left > 0; left -= 1 / 120) {
            const step = Math.min(left, 1 / 120);
            force
              .subVectors(goalPosition, coin.position)
              .multiplyScalar(stiffness)
              .addScaledVector(velocity, -damping);
            velocity.addScaledVector(force, step);
            coin.position.addScaledVector(velocity, step);
          }
          coin.quaternion.slerp(
            goalRotation,
            1 - Math.exp(-delta * (drag ? 22 : 10)),
          );
          if (
            hover ||
            velocity.lengthSq() > 1e-7 ||
            coin.position.distanceToSquared(goalPosition) > 1e-8 ||
            coin.quaternion.angleTo(goalRotation) > 1e-4
          )
            dirty = true;
          cameraDestination.set(0, 2.5, 2.7);
          aimDestination.set(0, 1, 0);
        }
        if (
          camera.position.distanceToSquared(cameraDestination) > 0.000001 ||
          cameraAim.distanceToSquared(aimDestination) > 0.000001
        ) {
          const ease = 1 - Math.exp(-delta * 7);
          camera.position.lerp(cameraDestination, ease);
          cameraAim.lerp(aimDestination, ease);
          camera.lookAt(cameraAim);
          dirty = true;
        }
      }
      const revealed = p.revealed && p.outcome ? p.outcome : null;
      if (revealed && revealedAt === null) revealedAt = now;
      if (!revealed && revealedAt !== null) {
        revealedAt = null;
        floor.material.color.setScalar(1);
        light.intensity = 2.7;
        // Flip again can land here mid-celebration, and the next coin must not fly lit.
        for (const material of faceMaterials) material.emissive.setScalar(0);
        glint.intensity = 0;
        ring.visible = false;
        moteCloud.visible = false;
        dirty = true;
      }
      if (revealed && revealedAt !== null) {
        const t = (now - revealedAt) / 1000;
        const live = revealed === 'won' && t < 1.2;
        if (revealed === 'lost') {
          const k = Math.min(1, t / 0.6);
          const eased = 1 - (1 - k) ** 3;
          floor.material.color.setScalar(1 - 0.42 * eased);
          light.intensity = 2.7 * (1 - 0.18 * eased);
          if (k < 1) dirty = true;
        }
        const peak =
          t < 0.15 ? t / 0.15 : Math.max(0, 1 - (t - 0.15) / 0.85) ** 2;
        for (const material of faceMaterials)
          material.emissive.copy(glow).multiplyScalar(live ? 0.85 * peak : 0);
        const sweep = t / 0.7;
        glint.intensity =
          live && sweep < 1 ? Math.sin(Math.PI * sweep) * 2.2 : 0;
        glint.position.set(
          coin.position.x - 0.9 + 1.8 * sweep,
          coin.position.y + 0.45,
          coin.position.z - 0.3 + 0.6 * sweep,
        );
        const spread = t / 0.8;
        ring.visible = live && spread < 1;
        ring.position.set(
          coin.position.x,
          COIN_TABLE_Y + 0.002,
          coin.position.z,
        );
        ring.scale.setScalar(1 + 1.3 * (1 - (1 - Math.min(1, spread)) ** 3));
        ring.material.opacity = 0.8 * Math.max(0, 1 - spread) ** 2;
        moteCloud.visible = live;
        const position = moteGeometry.getAttribute('position');
        const color = moteGeometry.getAttribute('color');
        motes.forEach(({ angle, delay, rise }, i) => {
          const life = Math.min(1, Math.max(0, (t - delay) / 0.95));
          const radius = 0.6 + 0.35 * life;
          position.setXYZ(
            i,
            coin.position.x + Math.cos(angle) * radius,
            coin.position.y + 0.08 + rise * life * (1 - 0.35 * life),
            coin.position.z + Math.sin(angle) * radius,
          );
          const alpha =
            t < delay
              ? 0
              : 0.9 * (life < 0.15 ? life / 0.15 : (1 - life) ** 1.4);
          color.setXYZ(i, alpha, alpha, alpha);
        });
        position.needsUpdate = true;
        color.needsUpdate = true;
        // A few frames past the end so the resting look is what stays drawn.
        if (revealed === 'won' && t < 1.3) dirty = true;
      }
      if (dirty && !document.hidden) {
        try {
          renderer.render(scene, camera);
        } catch {
          setFailed(true);
          return;
        }
        if (assetsReady && !readyReported) {
          readyReported = true;
          current.current.onReadyChange(true);
        }
        dirty = false;
      }
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => {
      disposed = true;
      abort.abort();
      current.current.onReadyChange(false);
      cancelAnimationFrame(request);
      observer.disconnect();
      canvas.removeEventListener('webglcontextlost', contextLost);
      canvas.removeEventListener('touchstart', touchStart);
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
      moteGeometry.dispose();
      moteMaterial.dispose();
      dotTexture.dispose();
      haloTexture.dispose();
      poolTexture.dispose();
      reeds.dispose();
      environment.dispose();
      light.shadow.dispose();
      renderer.dispose();
      // Browsers cap live contexts, and each reopened receipt builds a new one.
      renderer.forceContextLoss();
      canvas.remove();
    };
  }, [failed, sfx, vibrate]);
  return (
    <div ref={host} className="h-full w-full overflow-hidden bg-neutral-950" />
  );
}
