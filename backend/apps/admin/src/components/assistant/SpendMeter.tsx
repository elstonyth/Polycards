import { Tooltip } from '@medusajs/ui';
import { useTranslation } from 'react-i18next';

/**
 * Today's assistant spend against the daily cap, for the chat header: amber
 * from 75%, red once the cap refuses answers. Below `sm` only the bar shows;
 * its aria-label still carries the words.
 */
export function SpendMeter({ spent, cap }: { spent: number; cap: number }) {
  const { t } = useTranslation();
  const pct = Math.min(100, (spent / cap) * 100);
  // The same test the chat and speak routes refuse on.
  const full = spent >= cap;
  const amber = !full && pct >= 75;
  const label = full
    ? t('assistant.spend.reached', {
        defaultValue: 'USD {{cap}} limit reached',
        cap: +cap.toFixed(2),
      })
    : t('assistant.spend.today', {
        defaultValue: 'USD {{spent}} / {{cap}} today',
        // Down to the cent, so 4.996 of 5 never reads "5.00 / 5"; the
        // epsilon keeps 4.35 (434.999… cents) from reading 4.34.
        spent: (Math.floor(spent * 100 + 1e-9) / 100).toFixed(2),
        cap: +cap.toFixed(2),
      });
  return (
    <Tooltip
      content={t('assistant.spend.resets', {
        defaultValue: 'Resets at 00:00 Malaysia time',
      })}
    >
      <span
        tabIndex={0}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-label={label}
        className={`border-ui-border-base flex shrink-0 cursor-help items-center gap-x-2 rounded-full border px-2.5 py-1 text-[11px] tabular-nums ${full ? 'text-ui-tag-red-text' : amber ? 'text-ui-tag-orange-text' : 'text-ui-fg-subtle'}`}
      >
        <span className="hidden whitespace-nowrap sm:inline">{label}</span>
        <span className="bg-ui-bg-component block h-1 w-10 overflow-hidden rounded-full">
          <span
            className={`block h-full rounded-full ${full ? 'bg-ui-tag-red-icon' : amber ? 'bg-ui-tag-orange-icon' : 'bg-ui-fg-interactive'}`}
            style={{ width: `${pct}%` }}
          />
        </span>
      </span>
    </Tooltip>
  );
}
