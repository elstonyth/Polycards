import { useState } from 'react';
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Select,
  Switch,
  Table,
  Text,
  toast,
} from '@medusajs/ui';
import { CheckCircle } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import {
  useSaveTaskDefinition,
  useTaskDefinitions,
  type AdminTaskDefinition,
} from '../../lib/queries';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

// Tasks — the /task hub's weekly-task / achievement definitions (spec
// 2026-08-24 Phase B). Create/edit with a requirement + reward builder;
// retire with the Active switch (progress is computed live, so a definition
// change never corrupts anyone's history — claims are frozen snapshots).
export const config: RouteConfig = {
  label: 'Tasks',
  icon: CheckCircle,
  rank: 36, // after Referrals (35)
};

const REQUIREMENT_TYPES: Record<'weekly' | 'achievement', string[]> = {
  weekly: ['checkin_days', 'rip_count'],
  achievement: ['reach_level', 'vault_count', 'vault_pixel_count'],
};
const REQUIREMENT_LABEL: Record<string, string> = {
  checkin_days: 'Check in N days',
  rip_count: 'Rip N packs',
  reach_level: 'Reach VIP level N',
  vault_count: 'Vault N cards',
  vault_pixel_count: 'Vault N Pokémon (pixel) cards',
};
const REWARD_TYPES = ['credit', 'pack', 'card'] as const;
const REWARD_LABEL: Record<string, string> = {
  credit: 'Credit (RM)',
  pack: 'Free rip of a pack',
  card: 'A specific card',
};

interface Draft {
  id?: string;
  kind: 'weekly' | 'achievement';
  title: string;
  reqType: string;
  reqN: string;
  reqPack: string;
  rewardType: (typeof REWARD_TYPES)[number];
  rewardValue: string;
  active: boolean;
  sort: string;
}

const blankDraft = (): Draft => ({
  kind: 'weekly',
  title: '',
  reqType: 'checkin_days',
  reqN: '1',
  reqPack: '',
  rewardType: 'credit',
  rewardValue: '',
  active: true,
  sort: '0',
});

const draftFrom = (t: AdminTaskDefinition): Draft => {
  const req = t.requirement as Record<string, unknown>;
  const rew = t.reward as Record<string, unknown>;
  const n =
    (req.days as number | undefined) ??
    (req.count as number | undefined) ??
    (req.level as number | undefined) ??
    1;
  return {
    id: t.id,
    kind: t.kind,
    title: t.title,
    reqType: String(req.type ?? 'checkin_days'),
    reqN: String(n),
    reqPack: typeof req.pack_id === 'string' ? req.pack_id : '',
    rewardType: (rew.type as Draft['rewardType']) ?? 'credit',
    rewardValue:
      rew.type === 'credit'
        ? String(rew.amount_myr ?? '')
        : rew.type === 'pack'
          ? String(rew.pack_id ?? '')
          : String(rew.card_handle ?? ''),
    active: t.active,
    sort: String(t.sort),
  };
};

function draftToPayload(d: Draft): {
  requirement: Record<string, unknown>;
  reward: Record<string, unknown>;
} | null {
  const n = Number(d.reqN);
  if (!Number.isInteger(n) || n <= 0) return null;
  let requirement: Record<string, unknown>;
  switch (d.reqType) {
    case 'checkin_days':
      requirement = { type: d.reqType, days: n };
      break;
    case 'rip_count':
      requirement = {
        type: d.reqType,
        count: n,
        pack_id: d.reqPack.trim() || null,
      };
      break;
    case 'reach_level':
      requirement = { type: d.reqType, level: n };
      break;
    default:
      requirement = { type: d.reqType, count: n };
  }
  let reward: Record<string, unknown>;
  if (d.rewardType === 'credit') {
    const amount = Number(d.rewardValue);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    reward = { type: 'credit', amount_myr: amount };
  } else if (d.rewardType === 'pack') {
    if (!d.rewardValue.trim()) return null;
    reward = { type: 'pack', pack_id: d.rewardValue.trim() };
  } else {
    if (!d.rewardValue.trim()) return null;
    reward = { type: 'card', card_handle: d.rewardValue.trim() };
  }
  return { requirement, reward };
}

function TaskEditor({
  draft,
  onChange,
  onSaved,
  onCancel,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const save = useSaveTaskDefinition();
  const [reason, setReason] = useState('');
  const payload = draftToPayload(draft);
  const valid = Boolean(payload && draft.title.trim() && reason.trim());

  const submit = () => {
    if (!payload) return;
    save.mutate(
      {
        id: draft.id,
        kind: draft.kind,
        title: draft.title.trim(),
        requirement: payload.requirement,
        reward: payload.reward,
        active: draft.active,
        sort: Number(draft.sort) || 0,
        reason: reason.trim(),
      },
      {
        onSuccess: () => {
          toast.success(draft.id ? 'Task updated.' : 'Task created.');
          onSaved();
        },
        onError: (e) => toast.error(e.message),
      },
    );
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={draft.kind}
          onValueChange={(kind) => {
            const k = kind as Draft['kind'];
            onChange({ ...draft, kind: k, reqType: REQUIREMENT_TYPES[k][0] });
          }}
        >
          <Select.Trigger className="w-40">
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="weekly">Weekly</Select.Item>
            <Select.Item value="achievement">Achievement</Select.Item>
          </Select.Content>
        </Select>
        <Input
          value={draft.title}
          onChange={(e) => onChange({ ...draft, title: e.target.value })}
          placeholder="Title shown to players"
          className="w-72"
        />
        <div className="flex items-center gap-1">
          <Switch
            checked={draft.active}
            onCheckedChange={(active) => onChange({ ...draft, active })}
            aria-label="Active"
          />
          <Text size="small" className="text-ui-fg-subtle">
            Active
          </Text>
        </div>
        <Input
          type="number"
          value={draft.sort}
          onChange={(e) => onChange({ ...draft, sort: e.target.value })}
          className="w-20"
          aria-label="Sort"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Text size="small" className="text-ui-fg-subtle w-24">
          Requirement
        </Text>
        <Select
          value={draft.reqType}
          onValueChange={(reqType) => onChange({ ...draft, reqType })}
        >
          <Select.Trigger className="w-64">
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            {REQUIREMENT_TYPES[draft.kind].map((t) => (
              <Select.Item key={t} value={t}>
                {REQUIREMENT_LABEL[t]}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>
        <Input
          type="number"
          value={draft.reqN}
          onChange={(e) => onChange({ ...draft, reqN: e.target.value })}
          className="w-24"
          placeholder="N"
        />
        {draft.reqType === 'rip_count' && (
          <Input
            value={draft.reqPack}
            onChange={(e) => onChange({ ...draft, reqPack: e.target.value })}
            className="w-48"
            placeholder="Pack slug (blank = any)"
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Text size="small" className="text-ui-fg-subtle w-24">
          Reward
        </Text>
        <Select
          value={draft.rewardType}
          onValueChange={(rewardType) =>
            onChange({
              ...draft,
              rewardType: rewardType as Draft['rewardType'],
              rewardValue: '',
            })
          }
        >
          <Select.Trigger className="w-56">
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            {REWARD_TYPES.map((t) => (
              <Select.Item key={t} value={t}>
                {REWARD_LABEL[t]}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>
        <Input
          value={draft.rewardValue}
          onChange={(e) => onChange({ ...draft, rewardValue: e.target.value })}
          className="w-56"
          placeholder={
            draft.rewardType === 'credit'
              ? 'Amount (RM)'
              : draft.rewardType === 'pack'
                ? 'Pack slug'
                : 'Card handle'
          }
        />
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (audited)"
          className="w-64"
        />
        <Button
          size="small"
          onClick={submit}
          disabled={!valid || save.isPending}
        >
          {draft.id ? 'Save task' : 'Create task'}
        </Button>
        <Button size="small" variant="transparent" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

const TasksPage = () => {
  const { data, isLoading } = useTaskDefinitions();
  const [editing, setEditing] = useState<Draft | null>(null);

  return (
    <Container>
      <div className="flex items-center justify-between">
        <div>
          <Heading level="h2">Tasks</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Weekly tasks reset every Tue 00:00 MYT; achievements are once per
            account. Rewards pay as credit, a free rip, or a card straight to
            the vault.
          </Text>
        </div>
        <Button size="small" onClick={() => setEditing(blankDraft())}>
          New task
        </Button>
      </div>

      {editing && (
        <div className="mt-4">
          <TaskEditor
            draft={editing}
            onChange={setEditing}
            onSaved={() => setEditing(null)}
            onCancel={() => setEditing(null)}
          />
        </div>
      )}

      {isLoading || !data ? (
        <div className="mt-4">
          <LoadingSkeleton rows={4} />
        </div>
      ) : data.length === 0 ? (
        <Text size="small" className="text-ui-fg-muted mt-4">
          No tasks yet — create the first one.
        </Text>
      ) : (
        <Table className="mt-4">
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Title</Table.HeaderCell>
              <Table.HeaderCell>Kind</Table.HeaderCell>
              <Table.HeaderCell>Requirement</Table.HeaderCell>
              <Table.HeaderCell>Reward</Table.HeaderCell>
              <Table.HeaderCell>Status</Table.HeaderCell>
              <Table.HeaderCell />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {data.map((t) => {
              const req = t.requirement as Record<string, unknown>;
              const rew = t.reward as Record<string, unknown>;
              return (
                <Table.Row key={t.id}>
                  <Table.Cell>{t.title}</Table.Cell>
                  <Table.Cell>
                    <Badge size="2xsmall">{t.kind}</Badge>
                  </Table.Cell>
                  <Table.Cell>
                    <Text size="small">
                      {REQUIREMENT_LABEL[String(req.type)] ?? String(req.type)}{' '}
                      · {String(req.days ?? req.count ?? req.level ?? '')}
                      {typeof req.pack_id === 'string' && req.pack_id
                        ? ` · ${req.pack_id}`
                        : ''}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    <Text size="small">
                      {rew.type === 'credit'
                        ? `RM ${String(rew.amount_myr)}`
                        : rew.type === 'pack'
                          ? `Free rip · ${String(rew.pack_id)}`
                          : `Card · ${String(rew.card_handle)}`}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    <Badge size="2xsmall" color={t.active ? 'green' : 'grey'}>
                      {t.active ? 'active' : 'retired'}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell>
                    <Button
                      size="small"
                      variant="transparent"
                      onClick={() => setEditing(draftFrom(t))}
                    >
                      Edit
                    </Button>
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table>
      )}
    </Container>
  );
};

export default TasksPage;
