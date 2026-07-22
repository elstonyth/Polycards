import type { Metadata } from 'next';
import { Geist } from 'next/font/google';
import localFont from 'next/font/local';
import './globals.css';
import AppHeader from '@/components/app-shell/AppHeader';
import SiteFooter from '@/components/app-shell/SiteFooter';
import TabBar from '@/components/app-shell/TabBar';
import { TopUpProvider } from '@/components/app-shell/TopUpProvider';
import { AuthProvider } from '@/components/auth/AuthProvider';
import SkipLink from '@/components/SkipLink';
import CookieConsent from '@/components/CookieConsent';
import { SITE_URL } from '@/lib/site';
import { BUYBACK_RATE_LABEL } from '@/lib/buyback-copy';

const SITE_DESCRIPTION = `Rip packs. Pull graded cards. Hold, redeem, or sell back at ${BUYBACK_RATE_LABEL} value.`;

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

// Nekst Black — the display/heading font (self-hosted)
const nekst = localFont({
  src: '../../public/fonts/Nekst-Black.woff2',
  variable: '--font-nekst',
  weight: '900',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Polycards — Your Gateway to Physical & Digital Collectibles',
    template: '%s · Polycards',
  },
  description: SITE_DESCRIPTION,
  applicationName: 'Polycards',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'Polycards',
    title: 'Polycards — Your Gateway to Physical & Digital Collectibles',
    description: SITE_DESCRIPTION,
    url: '/',
    images: [
      { url: '/seo/og.png', width: 2400, height: 1260, alt: 'Polycards' },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Polycards — Your Gateway to Physical & Digital Collectibles',
    description: SITE_DESCRIPTION,
    images: ['/seo/og.png'],
  },
  appleWebApp: { capable: true, title: 'Polycards', statusBarStyle: 'black' },
  // Favicon + apple-touch icon come from src/app/icon.png + apple-icon.png.
};

export default async function RootLayout({
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
            <main id="main" className="flex-1 pb-12 lg:pb-8">
              {children}
            </main>
            {/* Footer carries the TabBar clearance (pb-28) on phones. */}
            <SiteFooter />
            <TabBar />
            <CookieConsent />
          </TopUpProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
