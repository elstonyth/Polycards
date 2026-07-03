import type { Metadata } from 'next';
import { Geist } from 'next/font/google';
import localFont from 'next/font/local';
import './globals.css';
import AppHeader from '@/components/app-shell/AppHeader';
import TabBar from '@/components/app-shell/TabBar';
import { TopUpProvider } from '@/components/app-shell/TopUpProvider';
import { AuthProvider } from '@/components/auth/AuthProvider';
import SkipLink from '@/components/SkipLink';
import CookieConsent from '@/components/CookieConsent';
import { SITE_URL } from '@/lib/site';

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
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Pokenic — Your Gateway to Physical & Digital Collectibles',
    template: '%s · Pokenic',
  },
  description:
    'Rip packs. Pull graded cards. Hold, trade, redeem, or sell back at up to 90% value.',
  applicationName: 'Pokenic',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'Pokenic',
    title: 'Pokenic — Your Gateway to Physical & Digital Collectibles',
    description:
      'Rip packs. Pull graded cards. Hold, trade, redeem, or sell back at up to 90% value.',
    url: '/',
    images: [{ url: '/seo/icon-512x512.png', width: 512, height: 512 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Pokenic — Your Gateway to Physical & Digital Collectibles',
    description:
      'Rip packs. Pull graded cards. Hold, trade, redeem, or sell back at up to 90% value.',
    images: ['/seo/icon-512x512.png'],
  },
  appleWebApp: { capable: true, title: 'Pokenic', statusBarStyle: 'black' },
  // Favicon + apple-touch icon come from src/app/icon.png + apple-icon.png.
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
        className="min-h-full flex flex-col bg-neutral-950 text-neutral-50"
      >
        <noscript>
          <div className="bg-amber-500 px-4 py-2 text-center text-sm font-medium text-neutral-900">
            This site needs JavaScript enabled for pack opening and live
            features.
          </div>
        </noscript>
        <AuthProvider>
          <TopUpProvider>
            <SkipLink />
            <AppHeader />
            {/* pb clears the fixed bottom TabBar on phones; none needed lg+. */}
            <main id="main" className="flex-1 pb-24 lg:pb-8">
              {children}
            </main>
            <TabBar />
            <CookieConsent />
          </TopUpProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
