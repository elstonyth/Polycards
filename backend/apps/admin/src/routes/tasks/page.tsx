import { useState } from 'react';
import {
  Button,
  Container,
  Heading,
  IconButton,
  Tabs,
  Text,
  toast,
  usePrompt,
} from '@medusajs/ui';
import {
  CheckCircleSolid,
  ChevronLeft,
  ChevronRight,
  ExclamationCircle,
} from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import {
  usePacks,
  useSaveTaskDefinition,
  useTaskDefinitions,
  type AdminTaskDefinition,
} from '../../lib/queries';
import {
  addWeeks,
  nameIssue,
  retiredInWeek,
  runsInWeek,
  weekLabel,
  weekStart,
} from './task-board';
import {
  blankDraft,
  draftFrom,
  draftToInput,
  issueFixes,
  issueText,
  taskStatus,
  toLocalInput,
  type Draft,
  type IssueFix,
} from './task-draft';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { RowActions } from '../../components/RowActions';
import { CheckInTrack, GoalArt, TaskRow } from './TaskBoard';
import { PlanWeek } from './PlanWeek';
import { TaskBuilder } from './TaskBuilder';

// Tasks — the /task hub's daily / weekly task and achievement definitions
// (spec 2026-08-24 Phase B; daily cadence 2026-10-06). Progress is computed live on read, so a definition edit
// never corrupts anyone's history; only claims are stored, and they freeze the
// reward they granted.
//
// Rebuilt as a week board 2026-11-02. Customers are paid by the rule while staff
// read the title, so a task now reads as its rule, a new name is written from the
// rule, a mismatch sits at the top of the page, and next week starts as a copy of
// this one.
export const config: RouteConfig = {
  label: 'pcNav.tasks',
  translationNs: 'translation',
  rank: 1,
  nested: '/rewards',
};

type Tab = 'weekly' | 'daily' | 'achievements' | 'retired';

const sum = (
  rows: AdminTaskDefinition[],
  f: (t: AdminTaskDefinition) => number,
): number => rows.reduce((a, t) => a + f(t), 0);

const money = (n: number): string =>
  `RM ${n.toLocaleString('en-MY', { maximumFractionDigits: 2 })}`;

const WeekSection = ({
  title,
  meta,
  onAdd,
  children,
}: {
  title: string;
  meta?: string;
  onAdd?: () => void;
  children: React.ReactNode;
}) => (
  <Container className="p-0">
    <div className="flex flex-wrap items-center gap-x-2.5 px-5 pt-3.5 pb-2">
      <Text size="small" weight="plus">
        {title}
      </Text>
      {meta && (
        <Text size="small" className="text-ui-fg-muted tabular-nums">
          {meta}
        </Text>
      )}
      {onAdd && (
        <Button
          size="small"
          variant="transparent"
          className="ml-auto"
          onClick={onAdd}
        >
          + Add
        </Button>
      )}
    </div>
    {children}
  </Container>
);

const TasksPage = () => {
  // Status is "as of the last fetch" — dataUpdatedAt, not a Date.now() in
  // render (impure; the React compiler lint refuses it). The list refetches
  // after every save, so a task scheduled a minute ago is badged correctly.
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    dataUpdatedAt: now,
  } = useTaskDefinitions();
  const save = useSaveTaskDefinition();
  const prompt = usePrompt();
  const [tab, setTab] = useState<Tab>('weekly');
  // null = whichever week it is now.
  const [picked, setPicked] = useState<number | null>(null);
  const [editing, setEditing] = useState<{
    draft: Draft;
    claims: number;
  } | null>(null);
  const [planFrom, setPlanFrom] = useState<number | null>(null);

  const thisWeek = weekStart(now);
  const week = picked ?? thisWeek;
  const past = week < thisWeek;
  const all = data ?? [];
  const inWeek = all.filter((t) => t.kind === 'weekly' && runsInWeek(t, week));
  const flagged = past ? [] : inWeek.filter((t) => nameIssue(t));
  // Only an any-pack mismatch needs the catalog, to say which pack it means.
  const { data: packs } = usePacks({
    enabled: flagged.some((t) => nameIssue(t)?.kind === 'any'),
  });

  const weekWindow = {
    startsAt: toLocalInput(new Date(week)),
    endsAt: toLocalInput(new Date(addWeeks(week, 1))),
  };
  const openNew = (over: Partial<Draft> = {}) =>
    setEditing({
      draft: { ...blankDraft(), ...weekWindow, ...over },
      claims: 0,
    });
  const openEdit = (t: AdminTaskDefinition) =>
    setEditing({ draft: draftFrom(t), claims: t.claims ?? 0 });

  // Retire / reactivate changes the switch and nothing else: the row's rule goes
  // back exactly as it came. It used to round-trip through the form, which could
  // rewrite the rule.
  const setActive = (
    t: AdminTaskDefinition,
    active: boolean,
    reason?: string,
  ) =>
    save.mutate(
      {
        id: t.id,
        kind: t.kind,
        title: t.title,
        requirement: t.requirement,
        reward: t.reward,
        active,
        sort: t.sort,
        tickets: t.tickets,
        starts_at: t.starts_at,
        ends_at: t.ends_at,
        reason:
          reason ?? (active ? 'Reactivated' : 'Retired from the task list'),
      },
      {
        onSuccess: () =>
          toast.success(active ? 'Task reactivated.' : 'Task retired.'),
        onError: (e) => toast.error(e.message),
      },
    );

  const applyFix = async (t: AdminTaskDefinition, fix: IssueFix) => {
    if (fix.action === 'open') return openEdit(t);
    const ok = await prompt({
      variant: fix.action === 'retire' ? 'danger' : 'confirmation',
      title: fix.label,
      description: fix.note,
      confirmText: fix.label,
      cancelText: 'Back',
    });
    if (!ok) return;
    if (fix.action === 'retire') {
      return setActive(t, false, 'Name and rule disagreed: retired');
    }
    const draft = fix.patch ? fix.patch(draftFrom(t)) : draftFrom(t);
    const input = draftToInput(draft, `Name and rule disagreed: ${fix.label}`);
    if (!input) {
      toast.error("This task's rule is incomplete. Open it to fix it.");
      return openEdit(t);
    }
    save.mutate(
      // The window is the row's own, to the second, not the form's rounding.
      {
        ...input,
        starts_at: t.starts_at,
        ends_at: t.ends_at,
        active: t.active,
      },
      {
        onSuccess: () =>
          toast.success('Saved. The reason is in the audit log.'),
        onError: (e) => toast.error(e.message),
      },
    );
  };

  const rowActions = (t: AdminTaskDefinition) => (
    <RowActions
      subject={t.title}
      actions={[
        { label: 'Edit', onSelect: () => openEdit(t) },
        {
          label: 'Duplicate',
          onSelect: () =>
            setEditing({
              draft: {
                ...draftFrom(t),
                ...(t.kind === 'weekly' ? weekWindow : {}),
                id: undefined,
                active: true,
              },
              claims: 0,
            }),
        },
        t.active
          ? {
              label: 'Retire',
              danger: true,
              onSelect: () => setActive(t, false),
              confirm: {
                title: 'Retire this task?',
                description:
                  'It leaves /task now. Only the on/off switch changes, so its rule stays as it is. Players who already finished it can still claim.',
              },
            }
          : { label: 'Reactivate', onSelect: () => setActive(t, true) },
      ]}
    />
  );

  const row = (t: AdminTaskDefinition, readOnly = false) => (
    <TaskRow
      key={t.id}
      t={t}
      flagged={t.active && Boolean(nameIssue(t))}
      onOpen={readOnly ? undefined : () => openEdit(t)}
      actions={readOnly ? undefined : rowActions(t)}
    />
  );

  const pulls = inWeek.filter(
    (t) => t.requirement.type === 'vault_pixel_count',
  );
  const rips = inWeek.filter((t) => t.requirement.type === 'rip_count');
  const topups = inWeek.filter((t) => t.requirement.type === 'topup_myr');
  const checkins = inWeek.filter((t) => t.requirement.type === 'checkin_days');
  const rewardValue = (t: AdminTaskDefinition) => t.view?.reward_value_myr ?? 0;
  const retiredNow = all.filter(
    (t) => t.kind === 'weekly' && retiredInWeek(t, week),
  );
  const listed = (kind: AdminTaskDefinition['kind']) =>
    all.filter(
      (t) => t.kind === kind && t.active && taskStatus(t, now) !== 'ended',
    );

  const rowsClass = 'grid gap-x-2 px-2 pb-2 xl:grid-cols-2';

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="p-0">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-6 pt-4 pb-3">
          <div>
            <Heading level="h1">Tasks</Heading>
            {tab === 'weekly' && (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-1">
                <IconButton
                  size="small"
                  variant="transparent"
                  aria-label="Previous week"
                  onClick={() => setPicked(addWeeks(week, -1))}
                >
                  <ChevronLeft />
                </IconButton>
                <Text
                  weight="plus"
                  className="min-w-[92px] text-center tabular-nums"
                >
                  {weekLabel(week)}
                </Text>
                <IconButton
                  size="small"
                  variant="transparent"
                  aria-label="Next week"
                  onClick={() => setPicked(addWeeks(week, 1))}
                >
                  <ChevronRight />
                </IconButton>
                <Text size="small" className="text-ui-fg-muted ml-2">
                  {week === thisWeek
                    ? 'This week · resets Monday 12 AM'
                    : past
                      ? 'A past week, read only'
                      : 'Upcoming'}
                </Text>
                {week !== thisWeek && (
                  <Button
                    size="small"
                    variant="transparent"
                    onClick={() => setPicked(null)}
                  >
                    Back to this week
                  </Button>
                )}
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {!past && (
              <Button
                size="small"
                variant="secondary"
                disabled={!data}
                onClick={() => setPlanFrom(week)}
              >
                Plan {weekLabel(addWeeks(week, 1))}
              </Button>
            )}
            <Button size="small" onClick={() => openNew()}>
              New task
            </Button>
          </div>
        </div>
        <div className="px-5 pb-3">
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
            <Tabs.List aria-label="Task type">
              <Tabs.Trigger value="weekly">Weekly</Tabs.Trigger>
              <Tabs.Trigger value="daily">Daily</Tabs.Trigger>
              <Tabs.Trigger value="achievements">Achievements</Tabs.Trigger>
              <Tabs.Trigger value="retired">Retired</Tabs.Trigger>
            </Tabs.List>
          </Tabs>
        </div>
      </Container>

      {editing && (
        <TaskBuilder
          initial={editing.draft}
          claims={editing.claims}
          weekRows={inWeek}
          weekText={weekLabel(week)}
          weekWindow={weekWindow}
          onClose={() => setEditing(null)}
        />
      )}
      {planFrom !== null && data && (
        <PlanWeek
          tasks={data}
          sourceWeek={planFrom}
          onClose={() => setPlanFrom(null)}
        />
      )}

      {isError ? (
        <Container className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
          <Text size="small" className="text-ui-fg-error">
            Tasks didn't load
            {error instanceof Error ? `: ${error.message}` : ''}.
          </Text>
          <Button size="small" variant="secondary" onClick={() => refetch()}>
            Try again
          </Button>
        </Container>
      ) : isLoading || !data ? (
        <Container className="px-6 py-4">
          <LoadingSkeleton rows={6} />
        </Container>
      ) : tab === 'daily' ? (
        <WeekSection
          title="Daily tasks"
          meta="Resets at midnight, Malaysia time"
          onAdd={() => openNew({ kind: 'daily', startsAt: '', endsAt: '' })}
        >
          {listed('daily').length === 0 ? (
            <Text
              size="small"
              className="text-ui-fg-subtle max-w-prose px-5 pb-4"
            >
              No daily tasks running. Anything finished but not claimed by
              midnight is lost.
            </Text>
          ) : (
            <ul className={rowsClass}>{listed('daily').map((t) => row(t))}</ul>
          )}
        </WeekSection>
      ) : tab === 'achievements' ? (
        <WeekSection
          title="Achievements"
          meta="Once per account, ever"
          onAdd={() =>
            openNew({ kind: 'achievement', startsAt: '', endsAt: '' })
          }
        >
          {listed('achievement').length === 0 ? (
            <Text size="small" className="text-ui-fg-subtle px-5 pb-4">
              No achievements yet.
            </Text>
          ) : (
            <ul className={rowsClass}>
              {listed('achievement').map((t) => row(t))}
            </ul>
          )}
        </WeekSection>
      ) : tab === 'retired' ? (
        <WeekSection title="Retired" meta="Switched off, kept for the record">
          {all.filter((t) => !t.active).length === 0 ? (
            <Text size="small" className="text-ui-fg-subtle px-5 pb-4">
              Nothing retired.
            </Text>
          ) : (
            <ul className={rowsClass}>
              {all.filter((t) => !t.active).map((t) => row(t))}
            </ul>
          )}
        </WeekSection>
      ) : inWeek.length === 0 ? (
        <Container className="flex flex-col items-center gap-y-3 px-6 py-10 text-center">
          <Text className="text-ui-fg-subtle">
            Nothing {past ? 'ran' : 'planned'} for {weekLabel(week)}.
          </Text>
          {!past && (
            <Button
              size="small"
              variant="secondary"
              onClick={() => setPlanFrom(addWeeks(week, -1))}
            >
              Copy from {weekLabel(addWeeks(week, -1))}
            </Button>
          )}
        </Container>
      ) : (
        <>
          {flagged.length > 0 ? (
            <section className="bg-ui-tag-orange-bg rounded-lg p-2 shadow-[0_0_0_1px_var(--tag-orange-border)]">
              <h2 className="text-ui-tag-orange-text flex items-center gap-x-2 px-3 pt-1.5 pb-2 text-sm font-semibold">
                <ExclamationCircle />
                {flagged.length === 1
                  ? '1 task pays differently from its name'
                  : `${flagged.length} tasks pay differently from their names`}
              </h2>
              <ul className="flex flex-col gap-y-1.5">
                {flagged.map((t) => {
                  const issue = nameIssue(t)!;
                  const words = issueText(t, issue);
                  return (
                    <li
                      key={t.id}
                      className="bg-ui-bg-base flex flex-wrap items-center gap-x-3.5 gap-y-2 rounded-md px-3.5 py-3"
                    >
                      <GoalArt t={t} />
                      <div className="min-w-0 flex-[1_1_320px]">
                        <Text size="small" leading="compact">
                          {words.headline}
                        </Text>
                        <Text
                          size="small"
                          leading="compact"
                          className="text-ui-fg-subtle mt-1 tabular-nums"
                        >
                          {words.detail}
                        </Text>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {issueFixes(t, issue, packs ?? []).map((fix) => (
                          <Button
                            key={fix.label}
                            size="small"
                            variant="secondary"
                            disabled={save.isPending}
                            onClick={() => void applyFix(t, fix)}
                          >
                            {fix.label}
                          </Button>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : (
            !past && (
              <Container className="flex items-center gap-x-2 px-5 py-2.5">
                <CheckCircleSolid className="text-ui-tag-green-icon" />
                <Text size="small" className="text-ui-fg-subtle">
                  Every task this week matches its name.
                </Text>
              </Container>
            )
          )}

          <WeekSection
            title="Check-in week"
            meta="Rewards by how many days a player has checked in"
          >
            <div className="px-5 pb-4">
              <CheckInTrack
                rows={checkins}
                onOpenDay={past ? undefined : openEdit}
                onAddDay={
                  past
                    ? undefined
                    : (day) =>
                        openNew({
                          reqType: 'checkin_days',
                          reqN: String(day),
                        })
                }
              />
            </div>
          </WeekSection>

          {pulls.length > 0 && (
            <WeekSection
              title="Pull a Pokémon"
              meta={`${pulls.length} tasks · up to ${sum(pulls, (t) => t.tickets ?? 0)} tickets`}
              onAdd={
                past
                  ? undefined
                  : () => openNew({ reqType: 'vault_pixel_count' })
              }
            >
              <ul className={rowsClass}>{pulls.map((t) => row(t, past))}</ul>
            </WeekSection>
          )}
          {rips.length > 0 && (
            <WeekSection
              title="Rip packs"
              meta={`${rips.length} tasks · up to ${money(sum(rips, rewardValue))} in free rips`}
              onAdd={past ? undefined : () => openNew({ reqType: 'rip_count' })}
            >
              <ul className={rowsClass}>{rips.map((t) => row(t, past))}</ul>
            </WeekSection>
          )}
          {topups.length > 0 && (
            <WeekSection
              title="Top up"
              meta={`${topups.length} tasks · up to ${money(sum(topups, rewardValue))} credit`}
              onAdd={past ? undefined : () => openNew({ reqType: 'topup_myr' })}
            >
              <ul className={rowsClass}>{topups.map((t) => row(t, past))}</ul>
            </WeekSection>
          )}
          {retiredNow.length > 0 && (
            <WeekSection title="Retired this week">
              <ul className={rowsClass}>
                {retiredNow.map((t) => row(t, past))}
              </ul>
            </WeekSection>
          )}
        </>
      )}
    </div>
  );
};

export default TasksPage;
