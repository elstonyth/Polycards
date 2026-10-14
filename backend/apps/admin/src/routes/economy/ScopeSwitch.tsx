import { useTranslation } from 'react-i18next';
import { Label, StatusBadge, Switch } from '@medusajs/ui';
import type { CustomerScope } from '../../lib/admin-rest';
import { Hint } from '../../components/Hint';

/**
 * Real customers (the Default group, no generated accounts) or every
 * account. The pill always says which numbers are on screen; the switch
 * widens to everyone. Shared by the Profit report and the Dashboard.
 */
export const ScopeSwitch = ({
  scope,
  onScope,
  hint,
}: {
  scope: CustomerScope;
  onScope: (next: CustomerScope) => void;
  /** Page-specific ⓘ text; defaults to what "All groups" includes. */
  hint?: string;
}) => {
  const { t } = useTranslation();
  const all = scope === 'all';
  return (
    <div className="flex flex-wrap items-center gap-3">
      <StatusBadge color={all ? 'grey' : 'green'}>
        {all ? t('profit.scopeAll') : t('profit.scopeReal')}
      </StatusBadge>
      <div className="flex items-center gap-2">
        <Switch
          id="pc-scope-all"
          size="small"
          checked={all}
          onCheckedChange={(on) => onScope(on ? 'all' : 'default')}
        />
        <Label
          htmlFor="pc-scope-all"
          size="small"
          className="text-ui-fg-subtle"
        >
          {t('profit.scopeAll')}
        </Label>
        <Hint text={hint ?? t('profit.scopeAllHint')} />
      </div>
    </div>
  );
};
