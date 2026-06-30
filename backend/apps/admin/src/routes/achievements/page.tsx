import { useState } from 'react';
import { Container, Heading, Text, Table, Input, Button, toast } from '@medusajs/ui';
import { Trophy } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { useAchievementDefs, useUpdateAchievementDef } from '../../lib/queries';
import type { AchievementDefDTO } from '../../lib/admin-rest';

export const config: RouteConfig = {
  label: 'Achievements',
  icon: Trophy,
  nested: '/gacha',
  rank: 5,
};

type DraftRow = { xp: number; threshold: number };

const AchievementsPage = () => {
  const { data: defs, isError } = useAchievementDefs();
  const update = useUpdateAchievementDef();
  const [draft, setDraft] = useState<Record<string, DraftRow>>({});

  function patch(key: string, base: DraftRow, field: keyof DraftRow, val: string) {
    const n = Number(val);
    if (!Number.isFinite(n)) return;
    const current = draft[key] ?? base;
    setDraft((p) => ({ ...p, [key]: { ...current, [field]: n } }));
  }

  async function save(def: AchievementDefDTO) {
    const d = draft[def.key] ?? { xp: Number(def.xp), threshold: Number(def.threshold) };
    try {
      await update.mutateAsync({
        key: def.key,
        body: {
          name: def.name,
          description: def.description,
          category: def.category,
          rarity: def.rarity,
          metric: def.metric,
          xp: d.xp,
          threshold: d.threshold,
        },
      });
      toast.success(`Saved ${def.key}`);
    } catch {
      // onError in the hook already toasts the backend message
    }
  }

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h2">Achievements</Heading>
        <Text className="text-ui-fg-subtle mt-1 max-w-2xl" size="small">
          Edit XP rewards and unlock thresholds for each achievement. Metric and key are fixed.
        </Text>
      </div>

      {isError && (
        <div className="px-6 py-4">
          <Text className="text-ui-fg-subtle">Failed to load achievements.</Text>
        </div>
      )}

      <Table>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>Name</Table.HeaderCell>
            <Table.HeaderCell>Metric</Table.HeaderCell>
            <Table.HeaderCell>Threshold</Table.HeaderCell>
            <Table.HeaderCell>XP</Table.HeaderCell>
            <Table.HeaderCell />
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(defs ?? []).map((def) => {
            const base: DraftRow = { xp: Number(def.xp), threshold: Number(def.threshold) };
            const d = draft[def.key] ?? base;
            return (
              <Table.Row key={def.key}>
                <Table.Cell>{def.name}</Table.Cell>
                <Table.Cell>{def.metric}</Table.Cell>
                <Table.Cell>
                  <Input
                    type="number"
                    min={1}
                    value={d.threshold}
                    onChange={(e) => patch(def.key, base, 'threshold', e.target.value)}
                    className="w-28 tabular-nums"
                  />
                </Table.Cell>
                <Table.Cell>
                  <Input
                    type="number"
                    min={0}
                    value={d.xp}
                    onChange={(e) => patch(def.key, base, 'xp', e.target.value)}
                    className="w-28 tabular-nums"
                  />
                </Table.Cell>
                <Table.Cell>
                  <Button
                    size="small"
                    variant="secondary"
                    isLoading={update.isPending}
                    onClick={() => save(def)}
                  >
                    Save
                  </Button>
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>
    </Container>
  );
};

export default AchievementsPage;
