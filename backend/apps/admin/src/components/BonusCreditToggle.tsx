import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Checkbox, Label, Text } from '@medusajs/ui';

// Operator credit forms put a grant on spend-only bonus credit by default
// (operator rule 2026-10-11): giveaways and compensation must never become
// withdrawable cash. Unticking is for real-money corrections only, e.g. a paid
// deposit that never reached the wallet. A deduction defaults to withdrawable
// credit (lib/credit-kind.ts); ticked, a negative amount takes bonus back.
export const BonusCreditToggle = ({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) => {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
        aria-describedby={`${id}-hint`}
      />
      <div className="flex flex-col">
        <Label htmlFor={id} size="small">
          {t('creditKind.bonus')}
        </Label>
        <Text id={`${id}-hint`} size="small" className="text-ui-fg-subtle">
          {t(checked ? 'creditKind.bonusHint' : 'creditKind.normalHint')}
        </Text>
      </div>
    </div>
  );
};
