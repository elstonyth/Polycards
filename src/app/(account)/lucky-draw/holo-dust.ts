import { HOLO_STOPS } from '@/lib/lucky-draw';

// Holo dust for the Lucky Draw win (spec §10, "Holo dust + prize reveal"),
// ported from docs/superpowers/specs/assets/lucky-draw-spin-prototype.html.
// Plain canvas, no React: the wheel starts it once the spin has stopped.
//
// The canvas sits 120% of the stage wide and starts 20% of its height above
// it (see SpinWheel), so the motes can rise past the wheel's top.

const HUES = [...HOLO_STOPS, '#ffffff'];

type Mote = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  life: number;
  max: number;
  c: string;
  tw: number;
  star: boolean;
};

const mote = (
  x: number,
  y: number,
  spreadX: number,
  spreadY: number,
  up: number,
): Mote => ({
  x: x + (Math.random() - 0.5) * spreadX,
  y: y + Math.random() * spreadY,
  vx: (Math.random() - 0.5) * 22,
  vy: -(up * (0.45 + Math.random() * 1.0)),
  r: 0.55 + Math.random() * 1.15,
  life: 0,
  max: 2.4 + Math.random() * 2.6,
  c: HUES[Math.floor(Math.random() * HUES.length)] ?? '#ffffff',
  tw: Math.random() * 6,
  star: Math.random() < 0.14, // a few four-point glints among the dust
});

export type HoloDust = {
  /** Glints rising out of the winning wedge (under the pointer) for 1.6 s. */
  burst: () => void;
  /** One softer 34-mote wave off the top edge of the rising prize frame. */
  wave: () => void;
  stop: () => void;
};

export function createHoloDust(canvas: HTMLCanvasElement): HoloDust {
  const ctx = canvas.getContext('2d');
  let raf = 0;
  let motes: Mote[] = [];
  let emitUntil = 0;
  let box = { width: 0, height: 0 };

  const size = () => {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    box = { width: rect.width, height: rect.height };
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const loop = () => {
    if (raf || !ctx) return;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (now < emitUntil && Math.random() < 0.7) {
        const wedgeTop = box.height * 0.2 + box.width * 0.06;
        motes.push(
          mote(box.width / 2, wedgeTop, box.width * 0.16, box.width * 0.22, 30),
        );
      }
      ctx.clearRect(0, 0, box.width, box.height);
      motes = motes.filter((m) => m.life < m.max);
      for (const m of motes) {
        m.life += dt;
        m.x += m.vx * dt;
        m.y += m.vy * dt;
        m.vx *= 0.985;
        m.vy *= 0.997;
        const a = Math.max(
          0,
          Math.sin((Math.PI * m.life) / m.max) *
            (0.65 + 0.35 * Math.sin(m.tw + m.life * 8)),
        );
        ctx.fillStyle = m.c;
        ctx.strokeStyle = m.c;
        ctx.globalAlpha = a * 0.16;
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.r * 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
        ctx.fill();
        if (m.star) {
          const L = m.r * 4.5;
          ctx.lineWidth = 0.6;
          ctx.globalAlpha = a * 0.8;
          ctx.beginPath();
          ctx.moveTo(m.x - L, m.y);
          ctx.lineTo(m.x + L, m.y);
          ctx.moveTo(m.x, m.y - L);
          ctx.lineTo(m.x, m.y + L);
          ctx.stroke();
        }
      }
      raf = motes.length || now < emitUntil ? requestAnimationFrame(tick) : 0;
    };
    raf = requestAnimationFrame(tick);
  };

  return {
    burst() {
      size();
      motes = [];
      emitUntil = performance.now() + 1600;
      loop();
    },
    wave() {
      if (!box.width) size();
      // The frame is 38% of the stage wide, 5:7, centred on the stage.
      const stage = box.width / 1.2;
      const top = box.height * 0.2 + stage * 0.5 - (stage * 0.38 * 1.4) / 2;
      for (let i = 0; i < 34; i++) {
        motes.push(mote(box.width / 2, top - 4, stage * 0.38, 6, 20));
      }
      loop();
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
      motes = [];
      emitUntil = 0;
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}
