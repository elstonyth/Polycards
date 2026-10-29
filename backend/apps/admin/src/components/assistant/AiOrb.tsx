import { motion, useReducedMotion } from 'framer-motion';

// The assistant's presence (21st.dev "thinking orb" pattern, our palette):
// a slowly turning iridescent sphere that breathes faster while it works.
export function AiOrb({
  size = 40,
  active = false,
}: {
  size?: number;
  active?: boolean;
}) {
  const still = useReducedMotion();
  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <motion.div
        className="absolute inset-0 rounded-full blur-md"
        style={{
          background:
            'conic-gradient(from 0deg, #7c3aed, #06b6d4, #f472b6, #f59e0b, #7c3aed)',
        }}
        animate={
          still
            ? undefined
            : { rotate: 360, opacity: active ? [0.55, 0.9, 0.55] : 0.5 }
        }
        transition={{
          rotate: {
            duration: active ? 3 : 9,
            repeat: Infinity,
            ease: 'linear',
          },
          opacity: { duration: 1.6, repeat: Infinity, ease: 'easeInOut' },
        }}
      />
      <motion.div
        className="absolute inset-[12%] rounded-full"
        style={{
          background:
            'radial-gradient(circle at 30% 28%, #ffffff 0%, #c4b5fd 18%, #7c3aed 46%, #0e1630 78%)',
          boxShadow:
            'inset -4px -6px 12px rgba(6,182,212,0.45), inset 3px 4px 10px rgba(255,255,255,0.35)',
        }}
        animate={
          still ? undefined : { scale: active ? [1, 1.07, 1] : [1, 1.025, 1] }
        }
        transition={{
          duration: active ? 1.1 : 3.2,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      />
    </div>
  );
}
