import type { Metadata } from 'next';
import { Geist } from 'next/font/google';
import localFont from 'next/font/local';
import './globals.css';
import AppHeader from '@/components/app-shell/AppHeader';
import SiteFooter from '@/components/app-shell/SiteFooter';
import InviteWelcome from '@/components/InviteWelcome';
import TabBar from '@/components/app-shell/TabBar';
import { CreditDotProvider } from '@/components/app-shell/CreditDotProvider';
import { TopUpProvider } from '@/components/app-shell/TopUpProvider';
import { VaultDotProvider } from '@/components/app-shell/VaultDotProvider';
import { AuthProvider } from '@/components/auth/AuthProvider';
import { SoundProvider } from '@/lib/use-sound';
import { GlobalFreePackBadge } from '@/components/FreePackBadge';
import { TelegramBanner } from '@/components/app-shell/TelegramBanner';
import { AnnouncementPopup } from '@/components/app-shell/AnnouncementPopup';
import { getAnnouncements } from '@/lib/data/announcements';
import SkipLink from '@/components/SkipLink';
import CookieConsent from '@/components/CookieConsent';
import MetaPixel from '@/components/MetaPixel';
import { SITE_URL } from '@/lib/site';
import { BUYBACK_RATE_LABEL } from '@/lib/buyback-copy';

const SITE_DESCRIPTION = `Rip packs. Pull graded cards. Hold, redeem, or sell from your vault at ${BUYBACK_RATE_LABEL} of card value.`;

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

// The announcement popup's live set is fetched here, so every prerendered
// page carries a copy of it. Without a revalidate, the fully static pages
// (/about, /privacy, /how-it-works …) would keep the BUILD-time set until the
// next deploy — and the root layout is not re-fetched on client navigation,
// so a visitor landing on one would never see a new announcement. The lowest
// revalidate across a route's segments wins, so home keeps its 15s and
// force-dynamic routes are unaffected.
export const revalidate = 60;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const announcements = await getAnnouncements();
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
        {/* No <noscript> tracking image: the cookie banner is JS-only, so a
            no-JS visitor can never consent — an unconditional pixel there
            would contradict the consent gate in MetaPixel.tsx. */}
        <MetaPixel />
        <SoundProvider>
          <AuthProvider>
            <CreditDotProvider>
              <TopUpProvider>
                <VaultDotProvider>
                  <SkipLink />
                  <AppHeader />
                  <main id="main" className="flex-1 pb-12 lg:pb-8">
                    {/* Referral-link landing. Client-only by design — reads the
                      ?invite param from window.location so the ISR-cached home
                      page stays visitor-agnostic. */}
                    <InviteWelcome />
                    {children}
                  </main>
                  {/* Footer carries the TabBar clearance (pb-28) on phones. */}
                  <SiteFooter />
                  <TabBar />
                  {/* Site-wide free-pack badge; /slots renders its own copy from
                    server state, so the global one skips that route. */}
                  <GlobalFreePackBadge />
                  <TelegramBanner />
                  {/* Admin-uploaded promo popup, once per MYT day; waits for
                    the cookie-consent answer like the badge and banner. */}
                  <AnnouncementPopup announcements={announcements} />
                  <CookieConsent />
                </VaultDotProvider>
              </TopUpProvider>
            </CreditDotProvider>
          </AuthProvider>
        </SoundProvider>
      </body>
    </html>
  );
}
