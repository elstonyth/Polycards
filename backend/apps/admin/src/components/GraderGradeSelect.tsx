import { useTranslation } from 'react-i18next';
import { Label, Select } from '@medusajs/ui';
import { PSA_GRADES } from '../lib/format';

const GRADERS = ['PSA', 'BGS', 'CGC', 'SGC'] as const;
const NONE = '__none__'; // @medusajs/ui Select rejects '' as an item value

// Operator asserts the physical slab's grader + grade (PriceCharting only
// supplies the price comp — §3a). Grade is a fixed dropdown so typos and
// impossible grades are unrepresentable.
export function GraderGradeSelect({
  grader,
  grade,
  onChange,
  idPrefix,
}: {
  grader: string;
  grade: string;
  onChange: (v: { grader: string; grade: string }) => void;
  idPrefix: string;
}) {
  const { t } = useTranslation();
  // A card edited here may carry a legacy off-scale grade (e.g. "9.5") from
  // before §3a — render it as an extra item so the select has something to
  // display, but never let the operator re-pick it once they move off.
  const legacyGrade =
    grade !== '' && !PSA_GRADES.includes(grade as (typeof PSA_GRADES)[number])
      ? grade
      : null;
  // Same treatment for an off-list grader (e.g. legacy "TAG"): without an
  // item carrying its value, the select renders blank-looking for the row.
  const legacyGrader =
    grader !== '' && !GRADERS.includes(grader as (typeof GRADERS)[number])
      ? grader
      : null;

  return (
    <div className="flex gap-4">
      <div className="flex flex-1 flex-col gap-y-2">
        <Label size="small" weight="plus" htmlFor={`${idPrefix}-grader`}>
          {t('cards.form.grader')}
        </Label>
        <Select
          value={grader === '' ? NONE : grader}
          onValueChange={(v) =>
            onChange({
              grader: v === NONE ? '' : v,
              grade: v === NONE ? '' : grade,
            })
          }
        >
          <Select.Trigger id={`${idPrefix}-grader`}>
            <Select.Value placeholder={t('cards.form.graderNone')} />
          </Select.Trigger>
          <Select.Content>
            <Select.Item value={NONE}>{t('cards.form.graderNone')}</Select.Item>
            {GRADERS.map((g) => (
              <Select.Item key={g} value={g}>
                {g}
              </Select.Item>
            ))}
            {legacyGrader !== null && (
              <Select.Item value={legacyGrader}>
                {legacyGrader} (legacy)
              </Select.Item>
            )}
          </Select.Content>
        </Select>
      </div>
      <div className="flex flex-1 flex-col gap-y-2">
        <Label size="small" weight="plus" htmlFor={`${idPrefix}-grade`}>
          {t('cards.form.grade')}
        </Label>
        <Select
          value={grade}
          onValueChange={(v) => onChange({ grader, grade: v })}
          disabled={grader === ''}
        >
          <Select.Trigger id={`${idPrefix}-grade`}>
            <Select.Value placeholder="—" />
          </Select.Trigger>
          <Select.Content>
            {PSA_GRADES.map((g) => (
              <Select.Item key={g} value={g}>
                {g}
              </Select.Item>
            ))}
            {legacyGrade !== null && (
              <Select.Item value={legacyGrade}>{legacyGrade} (legacy)</Select.Item>
            )}
          </Select.Content>
        </Select>
      </div>
    </div>
  );
}
