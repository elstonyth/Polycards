import { Send } from 'lucide-react';
import SiteFooter from '@/components/app-shell/SiteFooter';
import TrustBoard from '@/components/home/TrustBoard';
import { pillVariants } from '@/components/ui/pill';
import { TELEGRAM_URL } from '@/lib/site';
import { cn } from '@/lib/utils';
import styles from './home-flow.module.css';

/**
 * The Telegram section of the preview: the
 * Telegram link with the footer's own label, the trust points, then the site
 * footer itself. The layout's copy of the footer is hidden on this page by
 * home-flow.module.css, so the page shows one footer, here.
 */
export function FlowTelegram() {
  return (
    <div data-flow-section="telegram" className={styles.telegram}>
      <div className="px-fluid mt-14 flex justify-center">
        <a
          href={TELEGRAM_URL}
          className={cn(pillVariants({ variant: 'secondary', size: 'lg' }))}
        >
          <Send className="size-4" aria-hidden="true" />
          Telegram
        </a>
      </div>
      <TrustBoard />
      <div className="mt-14">
        <SiteFooter />
      </div>
    </div>
  );
}
