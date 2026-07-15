import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { pillVariants } from '@/components/ui/pill';

export const metadata: Metadata = {
  title: 'Download the app',
  description: 'The Polycards app is coming soon.',
};

// ponytail: placeholder page — swap in real store links when the app ships.
export default function DownloadPage() {
  return (
    <div className="px-fluid flex min-h-[60vh] flex-col items-center justify-center py-16 text-center">
      <Image
        src="/images/app/download-hero.webp"
        alt="Phone showing a graded holographic card, flanked by floating slabs"
        width={960}
        height={1286}
        priority
        sizes="(max-width: 640px) 80vw, 384px"
        className="w-72 max-w-[80vw] rounded-3xl border border-white/10 sm:w-96"
      />
      <h1 className="font-heading mt-6 text-3xl text-white">
        The Polycards app
      </h1>
      <p className="mt-3 max-w-md text-sm text-neutral-400">
        Coming soon — packs, vault, and live rips in your pocket. Until then,
        everything works right here in the browser.
      </p>
      <Link
        href="/slots"
        className={cn(pillVariants({ variant: 'primary' }), 'mt-8 px-8')}
      >
        Rip packs on the web
      </Link>
    </div>
  );
}
