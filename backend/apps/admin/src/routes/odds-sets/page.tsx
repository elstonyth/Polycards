import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Container,
  Heading,
  Select,
  Table,
  Text,
} from '@medusajs/ui';
import { Users } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { useCustomerGroupsAdmin, useSetGroupOddsSet } from '../../lib/queries';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

export const config: RouteConfig = {
  label: 'Odds Sets',
  icon: Users,
  nested: '/customers',
  rank: 3,
};

type OddsSet = 1 | 2 | 3;
const SETS: OddsSet[] = [1, 2, 3];

// Mirrors coerceOddsSet in packs/odds-sets.ts: group metadata is untyped JSON,
// so anything that is not exactly 2 or 3 (including a missing key) is set 1.
const coerce = (v: unknown): OddsSet =>
  v === 2 || v === '2' ? 2 : v === 3 || v === '3' ? 3 : 1;

// Groups are created, renamed and populated on the PREBUILT /customer-groups
// page (a compiled bundle we cannot extend) — this page owns one field on them.
const OddsSetsPage = () => {
  const navigate = useNavigate();
  const { data, isError } = useCustomerGroupsAdmin();
  const save = useSetGroupOddsSet();
  // Unsaved picks ONLY, keyed by group id. Seeding full row state from `data`
  // would go stale after the post-save invalidation refetch; an override map
  // falls back to the server value the moment its entry is dropped.
  const [picked, setPicked] = useState<Record<string, OddsSet>>({});

  const groups = data?.customer_groups ?? [];

  return (
    <Container className="p-0">
      <div className="px-6 py-4">
        <Heading level="h2">Odds Sets</Heading>
        <Text className="text-ui-fg-subtle mt-1" size="small">
          The default group (customers with no group) plays set 1. Set 2 falls
          back to set 1, set 3 to set 2, per card.
        </Text>
      </div>

      {isError ? (
        <div className="border-t px-6 py-8">
          <Text className="text-ui-fg-subtle">
            Could not load customer groups.
          </Text>
        </div>
      ) : !data ? (
        <div className="border-t px-6 py-8">
          <LoadingSkeleton />
        </div>
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-start gap-3 border-t px-6 py-8">
          <Text className="text-ui-fg-subtle">
            No customer groups yet. Create one first, then come back to assign
            its odds set.
          </Text>
          <Button
            size="small"
            variant="secondary"
            onClick={() => navigate('/customer-groups')}
          >
            Go to Customer Groups
          </Button>
        </div>
      ) : (
        <div
          className="overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-label="Customer group odds sets"
        >
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Group</Table.HeaderCell>
                <Table.HeaderCell>Odds set</Table.HeaderCell>
                <Table.HeaderCell className="text-right">
                  Actions
                </Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {groups.map((g) => {
                const saved = coerce(g.metadata?.odds_set);
                const value = picked[g.id] ?? saved;
                const dirty = value !== saved;
                return (
                  <Table.Row key={g.id}>
                    <Table.Cell>{g.name}</Table.Cell>
                    <Table.Cell>
                      <Select
                        value={String(value)}
                        onValueChange={(v) =>
                          setPicked((p) => ({ ...p, [g.id]: coerce(Number(v)) }))
                        }
                      >
                        <Select.Trigger className="w-28">
                          <Select.Value />
                        </Select.Trigger>
                        <Select.Content>
                          {SETS.map((s) => (
                            <Select.Item key={s} value={String(s)}>
                              Set {s}
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select>
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      <Button
                        size="small"
                        variant="secondary"
                        disabled={!dirty || save.isPending}
                        onClick={() =>
                          save.mutate(
                            { id: g.id, set: value },
                            {
                              // Drop the override so the row re-reads the
                              // (now authoritative) refetched server value.
                              onSuccess: () =>
                                setPicked((p) => {
                                  const next = { ...p };
                                  delete next[g.id];
                                  return next;
                                }),
                            },
                          )
                        }
                      >
                        Save
                      </Button>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </div>
      )}
    </Container>
  );
};

export default OddsSetsPage;
