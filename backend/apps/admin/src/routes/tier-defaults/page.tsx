import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Container, Heading, Input, Table, Text } from '@medusajs/ui';
import { Sparkles } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { RARITIES, type TierRangeMap } from '@acme/odds-math';
import { useSaveTierSettings, useTierSettings } from '../../lib/queries';
import type { TierRangeDTO, TierSettingsDTO } from '../../lib/admin-rest';
import {
  boundOk,
  parseBound,
  seedRangeRows,
  type RangeRowState,
} from '../../lib/tier-ranges';
import { StickySaveBar } from '../../components/StickySaveBar';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

export const config: RouteConfig = {
  label: 'Tier Defaults',
  icon: Sparkles,
  nested: '/products',
  rank: 4,
};

// One editable row per rarity: bounds as free-typed strings ('' = open side).
// String-bound helpers are shared with the pack editor's override section —
// see lib/tier-ranges (boundOk mirrors the server's 100M cap).
type FormState = Record<string, RangeRowState>;

const fromDTO = (dto: TierSettingsDTO): FormState =>
  seedRangeRows(dto.ranges as TierRangeMap);

const snapshot = (form: FormState): string => JSON.stringify(form);

/**
 * Tier Defaults (`/tier-defaults`): the RM display-price range per rarity
 * tier. The pack odds editor uses these ranges to DEFAULT a tier when a card
 * joins a prize pool, to confirm adds that fall outside every range, and to
 * badge rows whose price has drifted out of their tier — it never re-tiers a
 * card on its own.
 */
const TierDefaultsPage = () => {
  const { t } = useTranslation();
  const { data, isError } = useTierSettings();
  const save = useSaveTierSettings();
  const [form, setForm] = useState<FormState | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState('');
  const [reason, setReason] = useState('');

  // Seed once from the server (render-phase, same pattern as the odds editor);
  // a post-save reseed happens explicitly in onSave from the response.
  if (data && form === null) {
    const seeded = fromDTO(data);
    setForm(seeded);
    setSavedSnapshot(snapshot(seeded));
  }

  const rows = form ?? fromDTO({ ranges: {} });
  const dirty = form !== null && snapshot(form) !== savedSnapshot;

  const errors: string[] = [];
  for (const rarity of RARITIES) {
    const row = rows[rarity];
    if (!boundOk(row.min))
      errors.push(
        t('tierDefaults.errors.number', { tier: rarity, side: 'min' }),
      );
    if (!boundOk(row.max))
      errors.push(
        t('tierDefaults.errors.number', { tier: rarity, side: 'max' }),
      );
    const min = parseBound(row.min);
    const max = parseBound(row.max);
    if (
      boundOk(row.min) &&
      boundOk(row.max) &&
      min !== null &&
      max !== null &&
      min > max
    )
      errors.push(t('tierDefaults.errors.order', { tier: rarity }));
  }
  const reasonValid = reason.trim().length > 0;

  const setBound = (rarity: string, side: 'min' | 'max', value: string) =>
    setForm((prev) =>
      prev ? { ...prev, [rarity]: { ...prev[rarity], [side]: value } } : prev,
    );

  const onSave = async () => {
    if (!form) return;
    const ranges: Record<string, TierRangeDTO> = {};
    for (const rarity of RARITIES) {
      const row = form[rarity];
      if (row.min.trim() === '' && row.max.trim() === '') continue;
      ranges[rarity] = { min: parseBound(row.min), max: parseBound(row.max) };
    }
    try {
      const res = await save.mutateAsync({ ranges, reason: reason.trim() });
      const reseeded = fromDTO(res);
      setForm(reseeded);
      setSavedSnapshot(snapshot(reseeded));
      setReason('');
    } catch {
      /* onError toasts */
    }
  };

  if (isError) {
    return (
      <Container className="p-0">
        <div className="px-6 py-8">
          <Text className="text-ui-fg-subtle">
            {t('tierDefaults.loadError')}
          </Text>
        </div>
      </Container>
    );
  }
  if (!data && form === null) return <LoadingSkeleton />;

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="p-0">
        <div className="px-6 py-4">
          <Heading level="h2">{t('tierDefaults.title')}</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            {t('tierDefaults.subtitle')}
          </Text>
        </div>
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t('tierDefaults.tier')}</Table.HeaderCell>
              <Table.HeaderCell>{t('tierDefaults.min')}</Table.HeaderCell>
              <Table.HeaderCell>{t('tierDefaults.max')}</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {RARITIES.map((rarity) => (
              <Table.Row key={rarity}>
                <Table.Cell className="font-medium">{rarity}</Table.Cell>
                {(['min', 'max'] as const).map((side) => (
                  <Table.Cell key={side}>
                    <Input
                      size="small"
                      className="w-36"
                      inputMode="decimal"
                      placeholder={t('tierDefaults.openBound')}
                      aria-label={t('tierDefaults.boundLabel', {
                        tier: rarity,
                        side,
                      })}
                      value={rows[rarity][side]}
                      onChange={(e) => setBound(rarity, side, e.target.value)}
                    />
                  </Table.Cell>
                ))}
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
        <div className="px-6 py-3">
          <Text className="text-ui-fg-subtle" size="small">
            {t('tierDefaults.hint')}
          </Text>
        </div>
      </Container>
      <StickySaveBar
        dirty={dirty}
        saving={save.isPending}
        canSave={errors.length === 0 && reasonValid}
        onSave={onSave}
        label={t('tierDefaults.save')}
        message={
          errors.length > 0
            ? errors[0]
            : dirty && !reasonValid
              ? t('tierDefaults.reasonRequired')
              : undefined
        }
      >
        <div className="min-w-64 flex-1">
          <label
            className="text-ui-fg-subtle block text-xs font-medium"
            htmlFor="tier-defaults-reason"
          >
            {t('tierDefaults.reasonLabel')}
          </label>
          <Input
            id="tier-defaults-reason"
            placeholder={t('tierDefaults.reasonPlaceholder')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      </StickySaveBar>
    </div>
  );
};

export default TierDefaultsPage;
