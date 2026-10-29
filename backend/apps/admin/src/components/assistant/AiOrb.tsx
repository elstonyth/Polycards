import { useId } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

// The assistant's face: 21st.dev odysseyui "AI Orb Avatar" (blue preset) —
// a grainy glass orb with blinking eyes (admin-ui.css .pc-ai-eye). While it
// works it breathes and glances side to side. Sized in px so one component
// serves the 84px welcome, the header and each answer.
const ORB = {
  gradient:
    'radial-gradient(circle at 50% 45%, #0d4d9a 0%, #3d7dd8 40%, #6fb3ff 68%, #e0eeff 100%)',
  glow: '0 0 4px 0px rgba(20,102,216,.35), 0 0 16px 6px rgba(20,102,216,.18), inset 0 0 0 1px rgba(255,255,255,.05)',
  glowActive:
    '0 0 6px 1px rgba(20,102,216,.55), 0 0 22px 9px rgba(20,102,216,.3), inset 0 0 0 1px rgba(255,255,255,.08)',
  iris: 'linear-gradient(135deg, #ffffff 0%, #d4ecff 100%)',
  shine:
    'radial-gradient(ellipse at 30% 24%, rgba(255,255,255,.75) 0%, rgba(255,255,255,.1) 50%, transparent 70%)',
  shade:
    'radial-gradient(circle at 62% 68%, rgba(0,0,0,0.18) 0%, transparent 55%)',
};

export function AiOrb({
  size = 40,
  active = false,
}: {
  size?: number;
  active?: boolean;
}) {
  const still = useReducedMotion();
  const uid = useId().replace(/\W/g, '');
  const eye = {
    width: Math.max(2, Math.round(size * 0.125)),
    height: Math.max(3, Math.round(size * 0.19)),
    background: ORB.iris,
  };
  return (
    <motion.div
      aria-hidden
      className="relative flex shrink-0 items-center justify-center overflow-hidden rounded-full"
      style={{ width: size, height: size, background: ORB.gradient }}
      initial={false}
      animate={{
        boxShadow: active ? ORB.glowActive : ORB.glow,
        scale: active && !still ? [1, 1.05, 1] : 1,
      }}
      transition={{
        boxShadow: { duration: 0.4 },
        scale: active
          ? { duration: 1.4, repeat: Infinity, ease: 'easeInOut' }
          : { duration: 0.3 },
      }}
      whileTap={still ? undefined : { scaleX: 1.15, scaleY: 1.3 }}
    >
      {[
        { id: `pc-orb-n${uid}`, freq: '0.72', octaves: '4' },
        { id: `pc-orb-g${uid}`, freq: '3.2', octaves: '1' },
      ].map((f) => (
        <svg
          key={f.id}
          className="pointer-events-none absolute inset-0 opacity-20 mix-blend-overlay"
          width="100%"
          height="100%"
        >
          <filter id={f.id} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency={f.freq}
              numOctaves={Number(f.octaves)}
              stitchTiles="stitch"
            />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <rect width="100%" height="100%" filter={`url(#${f.id})`} />
        </svg>
      ))}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: ORB.shine }}
      />
      <div
        className="pointer-events-none absolute inset-0 blur-[2px]"
        style={{ background: ORB.shade }}
      />
      <motion.div
        className="relative z-10 flex items-center"
        style={{ gap: Math.round(size * 0.2), y: -Math.round(size * 0.04) }}
        animate={{
          x: active && !still ? [0, -size * 0.07, size * 0.07, 0] : 0,
        }}
        transition={
          active
            ? { duration: 2.4, repeat: Infinity, ease: 'easeInOut' }
            : { duration: 0.3 }
        }
      >
        <div className="pc-ai-eye rounded-full" style={eye} />
        <div className="pc-ai-eye rounded-full" style={eye} />
      </motion.div>
    </motion.div>
  );
}
