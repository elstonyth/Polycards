import type { Metadata } from 'next';
import { Geist } from 'next/font/google';
import localFont from 'next/font/local';
import './globals.css';
import SiteHeader from '@/components/SiteHeader';
import SiteFooter from '@/components/SiteFooter';
import { AuthProvider } from '@/components/auth/AuthProvider';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

// Nekst Black — the display/heading font used on phygitals.com (self-hosted)
const nekst = localFont({
  src: '../../public/fonts/Nekst-Black.woff2',
  variable: '--font-nekst',
  weight: '900',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Phygitals — Your Gateway to Physical & Digital Collectibles',
  description:
    'Rip packs. Pull graded cards. Hold, trade, redeem, or sell back at up to 90% value.',
  // Favicon + apple-touch icon come from the Next file convention (src/app/icon.png
  // and src/app/apple-icon.png — the Pokenic badge).
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      // Browser extensions (e.g. Dark Reader) inject attributes like
      // `data-darkreader-proxy-injected` onto <html>/<body> before React
      // hydrates, which is a benign source of hydration mismatches. Suppressing
      // here only ignores attribute diffs on these two root elements, not on the
      // app's actual content.
      suppressHydrationWarning
      className={`dark ${geistSans.variable} ${nekst.variable} h-full antialiased`}
    >
      <body
        suppressHydrationWarning
        className="min-h-full flex flex-col bg-neutral-900 text-neutral-50"
      >
        <AuthProvider>
          <SiteHeader />
          <main className="flex-1">{children}</main>
          <SiteFooter />
        </AuthProvider>
      </body>
    </html>
  );
}
