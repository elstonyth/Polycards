import type { Metadata } from 'next';
import { AlertCircle } from 'lucide-react';

// Live /clawmaker (anonymous) shows ONLY an in-place auth wall — an amber
// circle-exclamation in a faint warm glow, "Access Restricted", and "Please
// login to view this page." (wave-2 audit; the previous fabricated pack
// builder existed nowhere on live). The logged-in builder, if ever needed,
// must be recloned from a logged-in live capture.
export const metadata: Metadata = {
  title: 'Claw Maker',
  description: 'Build your own custom claw pack.',
};

export default function ClawMakerPage() {
  return (
    <div className="px-fluid flex min-h-[70vh] flex-col items-center justify-center py-16 text-center">
      <div className="relative flex h-20 w-20 items-center justify-center">
        <div
          className="absolute inset-0 rounded-full bg-amber-400/15 blur-2xl"
          aria-hidden
        />
        <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/10">
          <AlertCircle className="h-9 w-9 text-amber-400" aria-hidden />
        </div>
      </div>
      <h1 className="mt-6 text-2xl font-bold text-neutral-50">
        Access Restricted
      </h1>
      <p className="mt-2 text-sm text-neutral-400">
        Please login to view this page.
      </p>
    </div>
  );
}
