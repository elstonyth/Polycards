import { useState } from "react";
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Label,
  Select,
  Switch,
  Table,
  Text,
  toast,
} from "@medusajs/ui";
import { CheckCircle } from "@medusajs/icons";
import type { RouteConfig } from "@mercurjs/dashboard-sdk";
import {
  useCards,
  usePacks,
  usePixelPokemon,
  useSaveTaskDefinition,
  useTaskDefinitions,
  useVipLevels,
  type AdminTaskDefinition,
} from "../../lib/queries";
import { toLocalInput } from "../../lib/challenge-schedule";
import { LoadingSkeleton } from "../../components/LoadingSkeleton";

// Tasks — the /task hub's weekly-task / achievement definitions (spec
// 2026-08-24 Phase B). Create/edit with a requirement + reward builder;
// retire with the Active switch (progress is computed live, so a definition
// change never corrupts anyone's history — claims are frozen snapshots).
//
// Every "which thing" field is a PICKER, not a free-text id (2026-08-25): a
// typo'd pack slug or card handle was previously only caught by the save-time
// existence check, and there was no way to discover what the valid values
// were from this screen.
export const config: RouteConfig = {
  label: "Tasks",
  icon: CheckCircle,
  rank: 36, // after Referrals (35)
};

const REQUIREMENT_TYPES: Record<"weekly" | "achievement", string[]> = {
  weekly: ["checkin_days", "rip_count"],
  achievement: ["reach_level", "vault_count", "vault_pixel_count"],
};
const REQUIREMENT_LABEL: Record<string, string> = {
  checkin_days: "Check in N days",
  rip_count: "Rip N packs",
  reach_level: "Reach VIP level N",
  vault_count: "Vault N cards",
  vault_pixel_count: "Vault N Pokémon (pixel) cards",
};
const REWARD_TYPES = ["credit", "pack", "card"] as const;
const REWARD_LABEL: Record<string, string> = {
  credit: "Credit (RM)",
  pack: "Free rip of a pack",
  card: "A specific card",
};

// Select.Item cannot carry an empty value, so "no specific one" needs a
// sentinel that never collides with a real slug / handle / id.
const ANY = "__any__";

interface Draft {
  id?: string;
  kind: "weekly" | "achievement";
  title: string;
  reqType: string;
  reqN: string;
  /** rip_count: which pack (ANY = any pack). */
  reqPack: string;
  /** vault_pixel_count: which pixel Pokémon (ANY = any linked pixel card). */
  reqPixel: string;
  rewardType: (typeof REWARD_TYPES)[number];
  rewardValue: string;
  active: boolean;
  sort: string;
  /** datetime-local strings, same idiom as the Weekly Challenge schedule. */
  startsAt: string;
  endsAt: string;
}

const blankDraft = (): Draft => ({
  kind: "weekly",
  title: "",
  reqType: "checkin_days",
  reqN: "1",
  reqPack: ANY,
  reqPixel: ANY,
  rewardType: "credit",
  rewardValue: "",
  active: true,
  sort: "0",
  startsAt: "",
  endsAt: "",
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
    reqType: String(req.type ?? "checkin_days"),
    reqN: String(n),
    reqPack: typeof req.pack_id === "string" && req.pack_id ? req.pack_id : ANY,
    reqPixel:
      typeof req.pixel_pokemon_id === "string" && req.pixel_pokemon_id
        ? req.pixel_pokemon_id
        : ANY,
    rewardType: (rew.type as Draft["rewardType"]) ?? "credit",
    rewardValue:
      rew.type === "credit"
        ? String(rew.amount_myr ?? "")
        : rew.type === "pack"
          ? String(rew.pack_id ?? "")
          : String(rew.card_handle ?? ""),
    active: t.active,
    sort: String(t.sort),
    startsAt: t.starts_at ? toLocalInput(new Date(t.starts_at)) : "",
    endsAt: t.ends_at ? toLocalInput(new Date(t.ends_at)) : "",
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
    case "checkin_days":
      requirement = { type: d.reqType, days: n };
      break;
    case "rip_count":
      requirement = {
        type: d.reqType,
        count: n,
        pack_id: d.reqPack === ANY ? null : d.reqPack,
      };
      break;
    case "reach_level":
      requirement = { type: d.reqType, level: n };
      break;
    case "vault_pixel_count":
      requirement = {
        type: d.reqType,
        count: n,
        pixel_pokemon_id: d.reqPixel === ANY ? null : d.reqPixel,
      };
      break;
    default:
      requirement = { type: d.reqType, count: n };
  }
  let reward: Record<string, unknown>;
  if (d.rewardType === "credit") {
    const amount = Number(d.rewardValue);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    reward = { type: "credit", amount_myr: amount };
  } else if (d.rewardType === "pack") {
    if (!d.rewardValue.trim()) return null;
    reward = { type: "pack", pack_id: d.rewardValue.trim() };
  } else {
    if (!d.rewardValue.trim()) return null;
    reward = { type: "card", card_handle: d.rewardValue.trim() };
  }
  return { requirement, reward };
}

/** '' → null; anything else → the ISO instant the browser wall-clock means. */
const toIso = (local: string): string | null => {
  if (local === "") return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

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
  const [reason, setReason] = useState("");

  // Only fetch what the open editor can actually offer.
  const needsPacks = draft.reqType === "rip_count" || draft.rewardType === "pack";
  const { data: packs } = usePacks({ enabled: needsPacks });
  const { data: cards } = useCards({ enabled: draft.rewardType === "card" });
  const { data: vip } = useVipLevels();
  // The library runs past a thousand rows and the route caps a page at 200,
  // so the picker is search-then-select rather than one giant list.
  const [pixelQ, setPixelQ] = useState("");
  const { data: pixel } = usePixelPokemon(
    { q: pixelQ, limit: 200 },
    { enabled: draft.reqType === "vault_pixel_count" },
  );

  const payload = draftToPayload(draft);
  // A half-typed datetime is neither empty nor valid — refuse the save rather
  // than silently sending null (which would publish the task immediately).
  const scheduleOk =
    (draft.startsAt === "" || toIso(draft.startsAt) !== null) &&
    (draft.endsAt === "" || toIso(draft.endsAt) !== null) &&
    (draft.startsAt === "" ||
      draft.endsAt === "" ||
      new Date(draft.endsAt).getTime() > new Date(draft.startsAt).getTime());
  const valid = Boolean(
    payload && draft.title.trim() && reason.trim() && scheduleOk,
  );

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
        starts_at: toIso(draft.startsAt),
        ends_at: toIso(draft.endsAt),
        reason: reason.trim(),
      },
      {
        onSuccess: () => {
          toast.success(draft.id ? "Task updated." : "Task created.");
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
            const k = kind as Draft["kind"];
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
        {draft.reqType === "reach_level" ? (
          // The real ladder, not a free number — an operator typing 140 into
          // a 100-rung ladder writes a task nobody can ever finish.
          <Select
            value={draft.reqN}
            onValueChange={(reqN) => onChange({ ...draft, reqN })}
          >
            <Select.Trigger className="w-40">
              <Select.Value placeholder="VIP level" />
            </Select.Trigger>
            <Select.Content>
              {(vip?.levels ?? []).map((l) => (
                <Select.Item key={l.level} value={String(l.level)}>
                  Level {l.level}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
        ) : (
          <Input
            type="number"
            value={draft.reqN}
            onChange={(e) => onChange({ ...draft, reqN: e.target.value })}
            className="w-24"
            placeholder="N"
          />
        )}
        {draft.reqType === "rip_count" && (
          <Select
            value={draft.reqPack}
            onValueChange={(reqPack) => onChange({ ...draft, reqPack })}
          >
            <Select.Trigger className="w-64">
              <Select.Value placeholder="Any pack" />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value={ANY}>Any pack</Select.Item>
              {(packs ?? []).map((p) => (
                <Select.Item key={p.slug} value={p.slug}>
                  {p.title}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
        )}
        {draft.reqType === "vault_pixel_count" && (
          <>
            <Input
              value={pixelQ}
              onChange={(e) => setPixelQ(e.target.value)}
              className="w-44"
              placeholder="Search Pokémon…"
              aria-label="Search the pixel Pokémon library"
            />
            <Select
              value={draft.reqPixel}
              onValueChange={(reqPixel) => onChange({ ...draft, reqPixel })}
            >
              <Select.Trigger className="w-64">
                <Select.Value placeholder="Any Pokémon" />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value={ANY}>Any Pokémon</Select.Item>
                {/* The saved pick may not match the current search — keep it
                    listed so opening the editor never silently reassigns it. */}
                {draft.reqPixel !== ANY &&
                  !(pixel?.pixel_pokemon ?? []).some(
                    (p) => p.id === draft.reqPixel,
                  ) && (
                    <Select.Item value={draft.reqPixel}>
                      Current pick
                    </Select.Item>
                  )}
                {(pixel?.pixel_pokemon ?? []).map((p) => (
                  <Select.Item key={p.id} value={p.id}>
                    {p.dex ? `#${p.dex} ` : ""}
                    {p.name}
                    {p.variant !== "normal" ? ` (${p.variant})` : ""}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
          </>
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
              rewardType: rewardType as Draft["rewardType"],
              rewardValue: "",
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
        {draft.rewardType === "credit" && (
          <Input
            value={draft.rewardValue}
            onChange={(e) =>
              onChange({ ...draft, rewardValue: e.target.value })
            }
            className="w-56"
            placeholder="Amount (RM)"
          />
        )}
        {draft.rewardType === "pack" && (
          <Select
            value={draft.rewardValue}
            onValueChange={(rewardValue) => onChange({ ...draft, rewardValue })}
          >
            <Select.Trigger className="w-64">
              <Select.Value placeholder="Pick a pack" />
            </Select.Trigger>
            <Select.Content>
              {(packs ?? []).map((p) => (
                <Select.Item key={p.slug} value={p.slug}>
                  {p.title}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
        )}
        {draft.rewardType === "card" && (
          <Select
            value={draft.rewardValue}
            onValueChange={(rewardValue) => onChange({ ...draft, rewardValue })}
          >
            <Select.Trigger className="w-72">
              <Select.Value placeholder="Pick a card" />
            </Select.Trigger>
            <Select.Content>
              {(cards ?? []).map((c) => (
                <Select.Item key={c.handle} value={c.handle}>
                  {c.name}
                  {c.grade ? ` · ${c.grader} ${c.grade}` : ""}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
        )}
      </div>

      {/* Scheduling — the same datetime-local pair the Weekly Challenge
          schedule uses, so an operator only learns one control. Both bounds
          are optional: blank start = live now, blank end = until retired. */}
      <div className="flex flex-wrap items-end gap-2">
        <Text size="small" className="text-ui-fg-subtle mb-2 w-24">
          Schedule
        </Text>
        <div className="flex flex-col gap-1">
          <Label htmlFor="task-starts" size="small">
            Starts (optional)
          </Label>
          <Input
            id="task-starts"
            type="datetime-local"
            value={draft.startsAt}
            onChange={(e) => onChange({ ...draft, startsAt: e.target.value })}
            className="w-56"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="task-ends" size="small">
            Ends (optional)
          </Label>
          <Input
            id="task-ends"
            type="datetime-local"
            value={draft.endsAt}
            onChange={(e) => onChange({ ...draft, endsAt: e.target.value })}
            className="w-56"
          />
        </div>
        {!scheduleOk && (
          <Text size="small" className="text-ui-fg-error mb-2">
            The end must be after the start.
          </Text>
        )}
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
          {draft.id ? "Save task" : "Create task"}
        </Button>
        <Button size="small" variant="transparent" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

const dateLabel = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString() : "—";

const TasksPage = () => {
  const { data, isLoading } = useTaskDefinitions();
  const [editing, setEditing] = useState<Draft | null>(null);

  return (
    <Container>
      <div className="flex items-center justify-between">
        <div>
          <Heading level="h2">Tasks</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Weekly tasks reset every Mon 00:00 MYT; achievements are once per
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
              <Table.HeaderCell>Window</Table.HeaderCell>
              <Table.HeaderCell>Status</Table.HeaderCell>
              <Table.HeaderCell />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {data.map((t) => {
              const req = t.requirement as Record<string, unknown>;
              const rew = t.reward as Record<string, unknown>;
              const scoped =
                (typeof req.pack_id === "string" && req.pack_id) ||
                (typeof req.pixel_pokemon_id === "string" &&
                  req.pixel_pokemon_id);
              return (
                <Table.Row key={t.id}>
                  <Table.Cell>{t.title}</Table.Cell>
                  <Table.Cell>
                    <Badge size="2xsmall">{t.kind}</Badge>
                  </Table.Cell>
                  <Table.Cell>
                    <Text size="small">
                      {REQUIREMENT_LABEL[String(req.type)] ?? String(req.type)}{" "}
                      · {String(req.days ?? req.count ?? req.level ?? "")}
                      {scoped ? ` · ${scoped}` : ""}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    <Text size="small">
                      {rew.type === "credit"
                        ? `RM ${String(rew.amount_myr)}`
                        : rew.type === "pack"
                          ? `Free rip · ${String(rew.pack_id)}`
                          : `Card · ${String(rew.card_handle)}`}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    <Text size="small" className="text-ui-fg-subtle">
                      {t.starts_at || t.ends_at
                        ? `${dateLabel(t.starts_at)} → ${dateLabel(t.ends_at)}`
                        : "always"}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    <Badge size="2xsmall" color={t.active ? "green" : "grey"}>
                      {t.active ? "active" : "retired"}
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
