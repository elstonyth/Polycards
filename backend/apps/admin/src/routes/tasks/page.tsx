import { useState } from "react";
import {
  Badge,
  Button,
  Container,
  FocusModal,
  Heading,
  Input,
  Label,
  Select,
  Switch,
  Table,
  Text,
  Tooltip,
  toast,
} from "@medusajs/ui";
import { CheckCircle, InformationCircleSolid } from "@medusajs/icons";
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
import { RowActions } from "../../components/RowActions";

// Tasks — the /task hub's weekly-task / achievement definitions (spec
// 2026-08-24 Phase B). Progress is computed live on read, so a definition edit
// never corrupts anyone's history; only claims are stored, and they freeze the
// reward they granted.
//
// Rebuilt as a modal form 2026-08-25: the editor was a flat strip of unlabelled
// controls wedged above the list, and the list printed raw slugs and pixel
// ULIDs. Now the form is grouped and every field is named, the list is split by
// cadence, and the rows read as sentences (labels come from the server — see
// api/admin/tasks/labels.ts).
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
  checkin_days: "Check in on N days",
  rip_count: "Rip N packs",
  reach_level: "Reach VIP level N",
  vault_count: "Vault N cards",
  vault_pixel_count: "Vault N Pokémon (pixel) cards",
};
// What the number beside the requirement select actually counts.
const COUNT_LABEL: Record<string, string> = {
  checkin_days: "Days",
  rip_count: "Packs",
  reach_level: "Level",
  vault_count: "Cards",
  vault_pixel_count: "Cards",
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

// One labelled field. Every control in the form goes through this — the old
// editor's worst habit was a bare numeric input with nothing naming it.
const Field = ({
  label,
  htmlFor,
  hint,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) => (
  <div className={`flex flex-col gap-y-1 ${className ?? ""}`}>
    <Label htmlFor={htmlFor} size="small" weight="plus">
      {label}
    </Label>
    {children}
    {hint && (
      <Text size="small" className="text-ui-fg-subtle">
        {hint}
      </Text>
    )}
  </div>
);

const Section = ({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) => (
  <div className="border-ui-border-base flex flex-col gap-y-3 border-t pt-4 first:border-t-0 first:pt-0">
    <div>
      <Text weight="plus">{title}</Text>
      {description && (
        <Text size="small" className="text-ui-fg-subtle">
          {description}
        </Text>
      )}
    </div>
    {children}
  </div>
);

/**
 * A select whose saved value may not be in the options any more (a renamed or
 * deleted pack / card / Pokémon). Without the extra item the control falls back
 * to its PLACEHOLDER, which reads as "nothing selected" and invites the
 * operator to overwrite a binding they never knew was set.
 */
const StaleAwareSelect = ({
  value,
  onChange,
  placeholder,
  options,
  className,
  head,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  options: { value: string; label: string }[];
  className?: string;
  /** An always-present leading option, e.g. "Any pack". */
  head?: { value: string; label: string };
}) => {
  const known = options.some((o) => o.value === value) || head?.value === value;
  return (
    <Select value={value} onValueChange={onChange}>
      <Select.Trigger className={className}>
        <Select.Value placeholder={placeholder} />
      </Select.Trigger>
      <Select.Content>
        {head && <Select.Item value={head.value}>{head.label}</Select.Item>}
        {value !== "" && !known && (
          <Select.Item value={value}>{value} — current, not listed</Select.Item>
        )}
        {options.map((o) => (
          <Select.Item key={o.value} value={o.value}>
            {o.label}
          </Select.Item>
        ))}
      </Select.Content>
    </Select>
  );
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
  const [cardQuery, setCardQuery] = useState("");
  const [pixelQuery, setPixelQuery] = useState("");

  // Only fetch what the open form can actually offer.
  const needsPacks =
    draft.reqType === "rip_count" || draft.rewardType === "pack";
  const { data: packs } = usePacks({ enabled: needsPacks });
  const { data: cards } = useCards({ enabled: draft.rewardType === "card" });
  const { data: vip } = useVipLevels();
  // The library runs past a thousand rows and the route caps a page at 200, so
  // the picker is search-then-select rather than one giant list.
  const { data: pixel } = usePixelPokemon(
    { q: pixelQuery, limit: 200 },
    { enabled: draft.reqType === "vault_pixel_count" },
  );

  const packOptions = (packs ?? []).map((p) => ({
    value: p.slug,
    label: p.title,
  }));
  // Cards are unbounded; a raw list of every one is the least usable control on
  // the screen. Filtered client-side — useCards already holds the whole list.
  const cardOptions = (cards ?? [])
    .filter((c) =>
      cardQuery.trim() === ""
        ? true
        : `${c.name} ${c.handle}`
            .toLowerCase()
            .includes(cardQuery.trim().toLowerCase()),
    )
    .slice(0, 200)
    .map((c) => ({
      value: c.handle,
      label: c.grade ? `${c.name} · ${c.grader} ${c.grade}` : c.name,
    }));
  const pixelOptions = (pixel?.pixel_pokemon ?? []).map((p) => ({
    value: p.id,
    label: `${p.dex ? `#${p.dex} ` : ""}${p.name}${
      p.variant !== "normal" ? ` (${p.variant})` : ""
    }`,
  }));

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
    <FocusModal open onOpenChange={(o) => !o && onCancel()}>
      <FocusModal.Content>
        <FocusModal.Header>
          <div className="flex items-center gap-x-2">
            <Button size="small" variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              size="small"
              onClick={submit}
              isLoading={save.isPending}
              disabled={!valid || save.isPending}
            >
              {draft.id ? "Save changes" : "Create task"}
            </Button>
          </div>
        </FocusModal.Header>
        <FocusModal.Body className="pc-admin flex flex-col items-center overflow-auto p-10">
          <div className="flex w-full max-w-[720px] flex-col gap-y-6">
            <FocusModal.Title asChild>
              <Heading level="h2">
                {draft.id ? "Edit task" : "New task"}
              </Heading>
            </FocusModal.Title>

            <Section
              title="Basics"
              description="What players see, and whether it is running."
            >
              <Field
                label="Title"
                htmlFor="task-title"
                hint="Shown on the /task page exactly as typed."
              >
                <Input
                  id="task-title"
                  value={draft.title}
                  onChange={(e) => onChange({ ...draft, title: e.target.value })}
                  placeholder="e.g. Check in 3 days this week"
                />
              </Field>

              <div className="flex flex-wrap gap-4">
                <Field
                  label="Cadence"
                  hint={
                    draft.id
                      ? "Locked after creation — retire this task and make a new one instead."
                      : "Weekly resets every Monday 00:00 MYT. An achievement pays once per account, ever."
                  }
                  className="w-56"
                >
                  {/* Changing kind in place would re-open every claim already
                      made (kind drives period_key, which is the claim's unique
                      key), so the backend refuses it. Disabled rather than
                      left to fail on save — and the handler below also resets
                      reqType, so a stray change would clobber the config too. */}
                  <Select
                    value={draft.kind}
                    disabled={Boolean(draft.id)}
                    onValueChange={(kind) => {
                      const k = kind as Draft["kind"];
                      onChange({
                        ...draft,
                        kind: k,
                        reqType: REQUIREMENT_TYPES[k][0],
                      });
                    }}
                  >
                    <Select.Trigger>
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="weekly">Weekly task</Select.Item>
                      <Select.Item value="achievement">Achievement</Select.Item>
                    </Select.Content>
                  </Select>
                </Field>

                <Field
                  label="Order"
                  htmlFor="task-sort"
                  hint="Low numbers first. One list — weekly tasks and achievements share it."
                  className="w-40"
                >
                  <Input
                    id="task-sort"
                    type="number"
                    value={draft.sort}
                    onChange={(e) =>
                      onChange({ ...draft, sort: e.target.value })
                    }
                  />
                </Field>

                <Field
                  label="Active"
                  hint={
                    draft.active
                      ? "Listed on /task."
                      : "Hidden. Anyone who already finished it can still claim."
                  }
                  className="w-56"
                >
                  <div className="flex h-8 items-center">
                    <Switch
                      checked={draft.active}
                      onCheckedChange={(active) =>
                        onChange({ ...draft, active })
                      }
                      aria-label="Active"
                    />
                  </div>
                </Field>
              </div>
            </Section>

            <Section title="Goal" description="What the player has to do.">
              <div className="flex flex-wrap gap-4">
                <Field label="Type" className="w-72">
                  <Select
                    value={draft.reqType}
                    onValueChange={(reqType) => onChange({ ...draft, reqType })}
                  >
                    <Select.Trigger>
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
                </Field>

                <Field
                  label={COUNT_LABEL[draft.reqType] ?? "Amount"}
                  htmlFor="task-count"
                  className="w-32"
                >
                  {draft.reqType === "reach_level" ? (
                    // The real ladder, not a free number — 140 typed into a
                    // 100-rung ladder is a task nobody can ever finish.
                    <Select
                      value={draft.reqN}
                      onValueChange={(reqN) => onChange({ ...draft, reqN })}
                    >
                      <Select.Trigger>
                        <Select.Value placeholder="Level" />
                      </Select.Trigger>
                      <Select.Content>
                        {(vip?.levels ?? []).map((l) => (
                          <Select.Item key={l.level} value={String(l.level)}>
                            {l.level}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select>
                  ) : (
                    <Input
                      id="task-count"
                      type="number"
                      value={draft.reqN}
                      onChange={(e) =>
                        onChange({ ...draft, reqN: e.target.value })
                      }
                    />
                  )}
                </Field>

                {draft.reqType === "rip_count" && (
                  <Field
                    label="Which pack"
                    hint="Any pack counts unless you name one."
                    className="w-72"
                  >
                    <StaleAwareSelect
                      value={draft.reqPack}
                      onChange={(reqPack) => onChange({ ...draft, reqPack })}
                      placeholder="Any pack"
                      head={{ value: ANY, label: "Any pack" }}
                      options={packOptions}
                    />
                  </Field>
                )}

                {draft.reqType === "vault_pixel_count" && (
                  <>
                    <Field
                      label="Search Pokémon"
                      htmlFor="task-pixel-q"
                      className="w-48"
                    >
                      <Input
                        id="task-pixel-q"
                        value={pixelQuery}
                        onChange={(e) => setPixelQuery(e.target.value)}
                        placeholder="Pikachu…"
                      />
                    </Field>
                    <Field
                      label="Which Pokémon"
                      hint="Any linked pixel card counts unless you name one."
                      className="w-72"
                    >
                      <StaleAwareSelect
                        value={draft.reqPixel}
                        onChange={(reqPixel) => onChange({ ...draft, reqPixel })}
                        placeholder="Any Pokémon"
                        head={{ value: ANY, label: "Any Pokémon" }}
                        options={pixelOptions}
                      />
                    </Field>
                  </>
                )}
              </div>
            </Section>

            <Section
              title="Reward"
              description="Paid once, when the player claims."
            >
              <div className="flex flex-wrap gap-4">
                <Field label="Type" className="w-64">
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
                    <Select.Trigger>
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
                </Field>

                {draft.rewardType === "credit" && (
                  <Field
                    label="Amount (RM)"
                    htmlFor="task-credit"
                    className="w-40"
                  >
                    <Input
                      id="task-credit"
                      value={draft.rewardValue}
                      onChange={(e) =>
                        onChange({ ...draft, rewardValue: e.target.value })
                      }
                      placeholder="5"
                    />
                  </Field>
                )}

                {draft.rewardType === "pack" && (
                  <Field
                    label="Which pack"
                    hint="The claim rolls this pack's live odds and vaults the result."
                    className="w-72"
                  >
                    <StaleAwareSelect
                      value={draft.rewardValue}
                      onChange={(rewardValue) =>
                        onChange({ ...draft, rewardValue })
                      }
                      placeholder="Pick a pack"
                      options={packOptions}
                    />
                  </Field>
                )}

                {draft.rewardType === "card" && (
                  <>
                    <Field
                      label="Search cards"
                      htmlFor="task-card-q"
                      className="w-48"
                    >
                      <Input
                        id="task-card-q"
                        value={cardQuery}
                        onChange={(e) => setCardQuery(e.target.value)}
                        placeholder="Charizard…"
                      />
                    </Field>
                    <Field
                      label="Which card"
                      hint="Goes straight to the vault. It cannot be sold back."
                      className="w-72"
                    >
                      <StaleAwareSelect
                        value={draft.rewardValue}
                        onChange={(rewardValue) =>
                          onChange({ ...draft, rewardValue })
                        }
                        placeholder="Pick a card"
                        options={cardOptions}
                      />
                    </Field>
                  </>
                )}
              </div>
            </Section>

            <Section
              title="Schedule"
              description="Optional. Leave both blank to run from now until you retire it."
            >
              <div className="flex flex-wrap items-start gap-4">
                <Field label="Starts" htmlFor="task-starts" className="w-56">
                  <Input
                    id="task-starts"
                    type="datetime-local"
                    value={draft.startsAt}
                    onChange={(e) =>
                      onChange({ ...draft, startsAt: e.target.value })
                    }
                  />
                </Field>
                <Field label="Ends" htmlFor="task-ends" className="w-56">
                  <Input
                    id="task-ends"
                    type="datetime-local"
                    value={draft.endsAt}
                    onChange={(e) =>
                      onChange({ ...draft, endsAt: e.target.value })
                    }
                  />
                </Field>
              </div>
              {draft.endsAt !== "" && (
                // The window gates CLAIMING, not just listing. An operator
                // picking an end date should read that here rather than find
                // out from a player who lost a finished reward.
                <Text size="small" className="text-ui-fg-subtle">
                  ⚠ After the end time this task disappears and can no longer be
                  claimed — including by players who already finished it but had
                  not pressed Claim.
                </Text>
              )}
              {!scheduleOk && (
                <Text size="small" className="text-ui-fg-error">
                  The end must be after the start.
                </Text>
              )}
            </Section>

            <Section title="Audit">
              <Field
                label="Reason"
                htmlFor="task-reason"
                hint="Recorded against your admin account. Required."
              >
                <Input
                  id="task-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Launch week check-in task"
                />
              </Field>
            </Section>
          </div>
        </FocusModal.Body>
      </FocusModal.Content>
    </FocusModal>
  );
}

// `labels` is a NEW field. During a deploy the admin bundle ships either side
// of the backend, so a response without it must still render — the alternative
// is the whole console erroring out on `undefined.requirement`. Falling back to
// the raw type is ugly but legible, and it self-heals the moment the backend
// catches up.
const labelsOf = (t: AdminTaskDefinition): { requirement: string; reward: string } =>
  t.labels ?? {
    requirement: String((t.requirement as Record<string, unknown>)?.type ?? "—"),
    reward: String((t.reward as Record<string, unknown>)?.type ?? "—"),
  };

const dateLabel = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString() : "—";

const windowLabel = (t: AdminTaskDefinition): string =>
  t.starts_at || t.ends_at
    ? `${dateLabel(t.starts_at)} → ${dateLabel(t.ends_at)}`
    : "Always on";

const TaskTable = ({
  rows,
  onEdit,
  onToggleActive,
}: {
  rows: AdminTaskDefinition[];
  onEdit: (t: AdminTaskDefinition) => void;
  onToggleActive: (t: AdminTaskDefinition) => void;
}) => (
  <Table>
    <Table.Header>
      <Table.Row>
        <Table.HeaderCell>Title</Table.HeaderCell>
        <Table.HeaderCell>Goal</Table.HeaderCell>
        <Table.HeaderCell>Reward</Table.HeaderCell>
        <Table.HeaderCell>Runs</Table.HeaderCell>
        <Table.HeaderCell>Status</Table.HeaderCell>
        <Table.HeaderCell />
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {rows.map((t) => (
        <Table.Row key={t.id}>
          <Table.Cell>
            <div className="flex items-center gap-x-2">
              <Text size="small">{t.title}</Text>
              <Text size="small" className="text-ui-fg-muted tabular-nums">
                #{t.sort}
              </Text>
            </div>
          </Table.Cell>
          <Table.Cell className="text-ui-fg-subtle">
            {labelsOf(t).requirement}
          </Table.Cell>
          <Table.Cell className="text-ui-fg-subtle">
            {labelsOf(t).reward}
          </Table.Cell>
          <Table.Cell className="text-ui-fg-subtle whitespace-nowrap">
            {windowLabel(t)}
          </Table.Cell>
          <Table.Cell>
            <Badge size="2xsmall" color={t.active ? "green" : "grey"}>
              {t.active ? "active" : "retired"}
            </Badge>
          </Table.Cell>
          <Table.Cell className="text-right">
            <RowActions
              subject={t.title}
              actions={[
                { label: "Edit", onSelect: () => onEdit(t) },
                {
                  label: t.active ? "Retire" : "Reactivate",
                  danger: t.active,
                  onSelect: () => onToggleActive(t),
                },
              ]}
            />
          </Table.Cell>
        </Table.Row>
      ))}
    </Table.Body>
  </Table>
);

const EmptyRow = ({ what }: { what: string }) => (
  <Text size="small" className="text-ui-fg-muted px-6 py-4">
    No {what} yet.
  </Text>
);

const TasksPage = () => {
  const { data, isLoading } = useTaskDefinitions();
  const save = useSaveTaskDefinition();
  const [editing, setEditing] = useState<Draft | null>(null);

  // Retire / reactivate is the Active switch, applied straight from the row so
  // the common case never needs the form. Same audited POST as a save.
  const toggleActive = (t: AdminTaskDefinition) => {
    const d = draftFrom(t);
    const payload = draftToPayload(d);
    if (!payload) {
      toast.error("This task's config is invalid — open it to fix it first.");
      return;
    }
    save.mutate(
      {
        id: t.id,
        kind: t.kind,
        title: t.title,
        requirement: payload.requirement,
        reward: payload.reward,
        active: !t.active,
        sort: t.sort,
        starts_at: t.starts_at,
        ends_at: t.ends_at,
        reason: t.active ? "Retired from the task list" : "Reactivated",
      },
      {
        onSuccess: () =>
          toast.success(t.active ? "Task retired." : "Task reactivated."),
        onError: (e) => toast.error(e.message),
      },
    );
  };

  const weekly = (data ?? []).filter((t) => t.kind === "weekly");
  const achievements = (data ?? []).filter((t) => t.kind === "achievement");

  return (
    <Container className="p-0">
      <div className="flex items-start justify-between px-6 py-4">
        <div>
          <Heading level="h2">Tasks</Heading>
          <Text size="small" className="text-ui-fg-subtle mt-1">
            What players can earn on the /task page. Rewards pay as credit, a
            free rip, or a card straight to the vault.
          </Text>
        </div>
        <Button size="small" onClick={() => setEditing(blankDraft())}>
          New task
        </Button>
      </div>

      {editing && (
        <TaskEditor
          draft={editing}
          onChange={setEditing}
          onSaved={() => setEditing(null)}
          onCancel={() => setEditing(null)}
        />
      )}

      {isLoading || !data ? (
        <div className="px-6 pb-6">
          <LoadingSkeleton rows={4} />
        </div>
      ) : (
        <>
          <div className="border-ui-border-base flex items-center gap-x-2 border-t px-6 py-3">
            <Text weight="plus">Weekly tasks</Text>
            <Tooltip content="Progress and claims reset every Monday 00:00 MYT. Anything finished but unclaimed at the reset is lost.">
              <InformationCircleSolid className="text-ui-fg-muted" />
            </Tooltip>
          </div>
          {weekly.length === 0 ? (
            <EmptyRow what="weekly tasks" />
          ) : (
            <TaskTable
              rows={weekly}
              onEdit={(t) => setEditing(draftFrom(t))}
              onToggleActive={toggleActive}
            />
          )}

          <div className="border-ui-border-base flex items-center gap-x-2 border-t px-6 py-3">
            <Text weight="plus">Achievements</Text>
            <Tooltip content="Claimable once per account, ever. Progress is lifetime and never resets.">
              <InformationCircleSolid className="text-ui-fg-muted" />
            </Tooltip>
          </div>
          {achievements.length === 0 ? (
            <EmptyRow what="achievements" />
          ) : (
            <TaskTable
              rows={achievements}
              onEdit={(t) => setEditing(draftFrom(t))}
              onToggleActive={toggleActive}
            />
          )}
        </>
      )}
    </Container>
  );
};

export default TasksPage;
