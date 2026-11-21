import SiteFooter from '@/components/app-shell/SiteFooter';
import { cn } from '@/lib/utils';
import styles from './home-flow.module.css';

/**
 * The site footer as a section of the preview (Rules, Privacy, Contact, How
 * it works, About, Telegram, the copyright line). The layout's copy of the
 * footer is hidden on this page by home-flow.module.css, so the page shows
 * one footer, here.
 */
export function FlowFooter() {
  return (
    <div className={cn('mt-14', styles.footer)}>
      <SiteFooter />
    </div>
  );
}
