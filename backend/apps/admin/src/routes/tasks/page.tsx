import { useState } from 'react';
import {
  Button,
  Container,
  Heading,
  IconButton,
  Tabs,
  Text,
  Tooltip,
  toast,
  usePrompt,
} from '@medusajs/ui';
import {
  CheckCircleSolid,
  ChevronLeft,
  ChevronRight,
  ExclamationCircle,
  InformationCircle,
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
  coversWeek,
  money,
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
  windowLabel,
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

// The list route's cap: GET /admin/tasks returns the newest this many.
const LIST_CAP = 500;

const sum = (
  rows: AdminTaskDefinition[],
  f: (t: AdminTaskDefinition) => number,
): number => rows.reduce((a, t) => a + f(t), 0);

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

const WeekSection = ({
  title,
  meta,
  help,
  onAdd,
  children,
}: {
  title: string;
  meta?: string;
  help?: string;
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
      {help && (
        <Tooltip content={help}>
          <InformationCircle className="text-ui-fg-muted" />
        </Tooltip>
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
  const inWeekOf = (start: number) =>
    all.filter((t) => t.kind === 'weekly' && runsInWeek(t, start));
  const inWeek = inWeekOf(week);
  // A new task can't go into a week that's over, so from a past week it goes to
  // this one, and the builder says so.
  const editWeek = past ? thisWeek : week;
  const editWindow = {
    startsAt: toLocalInput(new Date(editWeek)),
    endsAt: toLocalInput(new Date(addWeeks(editWeek, 1))),
  };

  const flagged = (rows: AdminTaskDefinition[]) =>
    rows.filter((t) => t.active && nameIssue(t));
  const listed = (kind: AdminTaskDefinition['kind']) =>
    all.filter(
      (t) => t.kind === kind && t.active && taskStatus(t, now) !== 'ended',
    );
  const dailyRows = listed('daily');
  const achievementRows = listed('achievement');
  // Every row that's flagged somewhere reachable, for the pack catalog below.
  const flaggedNow = flagged(
    tab === 'daily'
      ? dailyRows
      : tab === 'achievements'
        ? achievementRows
        : past
          ? []
          : inWeek,
  );
  // Only an any-pack mismatch needs the catalog, to say which pack it means.
  const { data: packs } = usePacks({
    enabled: flaggedNow.some((t) => nameIssue(t)?.kind === 'any'),
  });

  const openNew = (over: Partial<Draft> = {}) => {
    const kind = over.kind ?? 'weekly';
    setEditing({
      draft: {
        ...blankDraft(),
        ...(kind === 'weekly' ? editWindow : {}),
        ...over,
      },
      claims: 0,
    });
  };
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
        onSuccess: () => {
          if (!active) return toast.success('Task retired.');
          if (t.ends_at && new Date(t.ends_at).getTime() <= now) {
            toast.warning(
              "Task reactivated, but its end date has passed, so it isn't live. Edit it to change the dates.",
            );
            return;
          }
          toast.success('Task reactivated.');
        },
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
    save.mutate(input, {
      onSuccess: () => toast.success('Saved. The reason is in the audit log.'),
      onError: (e) => toast.error(e.message),
    });
  };

  const rowActions = (t: AdminTaskDefinition, readOnly: boolean) => (
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
                ...(t.kind === 'weekly' ? editWindow : {}),
                id: undefined,
                active: true,
                saved: undefined,
              },
              claims: 0,
            }),
        },
        ...(readOnly
          ? []
          : t.active
            ? [
                {
                  label: 'Retire',
                  danger: true,
                  onSelect: () => setActive(t, false),
                  confirm: {
                    title: 'Retire this task?',
                    description:
                      'It leaves /task now. Only the on/off switch changes, so its rule stays as it is. Players who already finished it can still claim.',
                  },
                },
              ]
            : [
                {
                  label: 'Reactivate',
                  onSelect: () => setActive(t, true),
                },
              ]),
      ]}
    />
  );

  // The week header already says when a weekly row runs, so a row only speaks up
  // when its own window differs.
  const weeklyRow = (t: AdminTaskDefinition) => {
    const offWeek = !coversWeek(t, week);
    return (
      <TaskRow
        key={t.id}
        t={t}
        flagged={t.active && Boolean(nameIssue(t))}
        status={offWeek ? taskStatus(t, now) : undefined}
        note={offWeek ? windowLabel(t) : null}
        onOpen={past ? undefined : () => openEdit(t)}
        actions={rowActions(t, past)}
      />
    );
  };
  const listRow = (t: AdminTaskDefinition) => (
    <TaskRow
      key={t.id}
      t={t}
      flagged={t.active && Boolean(nameIssue(t))}
      status={taskStatus(t, now)}
      note={t.starts_at || t.ends_at ? windowLabel(t) : null}
      onOpen={() => openEdit(t)}
      actions={rowActions(t, false)}
    />
  );

  const issueStrip = (rows: AdminTaskDefinition[]) => (
    <section className="bg-ui-tag-orange-bg rounded-lg p-2 shadow-[0_0_0_1px_var(--tag-orange-border)]">
      <h2 className="text-ui-tag-orange-text flex items-center gap-x-2 px-3 pt-1.5 pb-2 text-sm font-semibold">
        <ExclamationCircle />
        {rows.length === 1
          ? '1 task pays differently from its name'
          : `${rows.length} tasks pay differently from their names`}
      </h2>
      <ul className="flex flex-col gap-y-1.5">
        {rows.map((t) => {
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
                {words.detail && (
                  <Text
                    size="small"
                    leading="compact"
                    className="text-ui-fg-subtle mt-1 tabular-nums"
                  >
                    {words.detail}
                  </Text>
                )}
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
  );

  const ofType = (type: string) =>
    inWeek.filter((t) => t.requirement.type === type);
  const pulls = ofType('vault_pixel_count');
  const rips = ofType('rip_count');
  const topups = ofType('topup_myr');
  const checkins = ofType('checkin_days');
  const others = inWeek.filter(
    (t) =>
      !['vault_pixel_count', 'rip_count', 'topup_myr', 'checkin_days'].includes(
        String(t.requirement.type),
      ),
  );
  const freeRips = sum(rips, (t) =>
    t.reward.type === 'pack' ? (t.view?.reward_value_myr ?? 0) : 0,
  );
  const credits = sum(topups, (t) =>
    t.reward.type === 'credit' ? Number(t.reward.amount_myr ?? 0) : 0,
  );
  const tickets = sum(pulls, (t) => t.tickets ?? 0);
  const retiredNow = all.filter(
    (t) => t.kind === 'weekly' && retiredInWeek(t, week),
  );
  const retiredTab = all.filter(
    (t) => !t.active || (t.kind !== 'weekly' && taskStatus(t, now) === 'ended'),
  );
  const doubledDay = checkins.some(
    (a) =>
      checkins.filter(
        (b) => Number(b.requirement.days) === Number(a.requirement.days),
      ).length > 1,
  );

  const rowsClass = 'grid gap-x-2 px-2 pb-2 xl:grid-cols-2';
  const weekMeta = (n: number, extra: string | null) =>
    [plural(n, 'task', 'tasks'), extra].filter(Boolean).join(' · ');

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="p-0">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-6 pt-4 pb-3">
          <div>
            <Heading level="h1">Tasks</Heading>
            {tab === 'weekly' && data && (
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
                      ? 'A past week'
                      : 'Upcoming'}
                </Text>
                <Tooltip content="Progress and claims reset every Monday at 12 AM, Malaysia time. Anything finished but not claimed by then is lost.">
                  <InformationCircle className="text-ui-fg-muted ml-1" />
                </Tooltip>
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
            {tab === 'weekly' && !past && inWeek.length > 0 && (
              <Button
                size="small"
                variant="secondary"
                onClick={() => setPlanFrom(week)}
              >
                Plan {weekLabel(addWeeks(week, 1))}
              </Button>
            )}
            <Button
              size="small"
              disabled={!data}
              onClick={() =>
                openNew(
                  tab === 'daily'
                    ? { kind: 'daily' }
                    : tab === 'achievements'
                      ? { kind: 'achievement' }
                      : {},
                )
              }
            >
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
          weekRows={inWeekOf(editWeek)}
          weekText={weekLabel(editWeek)}
          weekWindow={editWindow}
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

      {all.length >= LIST_CAP && (
        <Text size="small" className="text-ui-fg-subtle px-1">
          Showing the newest {LIST_CAP} tasks. Older ones aren't listed.
        </Text>
      )}

      {isError && !data ? (
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
        <>
          {flagged(dailyRows).length > 0 && issueStrip(flagged(dailyRows))}
          <WeekSection
            title="Daily tasks"
            meta="Resets at midnight, Malaysia time"
            help="Progress and claims reset every day at midnight, Malaysia time. Anything finished but not claimed by then is lost."
            onAdd={() => openNew({ kind: 'daily' })}
          >
            {dailyRows.length === 0 ? (
              <Text
                size="small"
                className="text-ui-fg-subtle max-w-prose px-5 pb-4"
              >
                No daily tasks running. Anything finished but not claimed by
                midnight is lost.
              </Text>
            ) : (
              <ul className={rowsClass}>{dailyRows.map(listRow)}</ul>
            )}
          </WeekSection>
        </>
      ) : tab === 'achievements' ? (
        <>
          {flagged(achievementRows).length > 0 &&
            issueStrip(flagged(achievementRows))}
          <WeekSection
            title="Achievements"
            meta="Once per account, ever"
            help="Claimable once per account, ever. Progress is lifetime and never resets."
            onAdd={() => openNew({ kind: 'achievement' })}
          >
            {achievementRows.length === 0 ? (
              <Text size="small" className="text-ui-fg-subtle px-5 pb-4">
                No achievements yet.
              </Text>
            ) : (
              <ul className={rowsClass}>{achievementRows.map(listRow)}</ul>
            )}
          </WeekSection>
        </>
      ) : tab === 'retired' ? (
        <WeekSection
          title="Retired"
          meta="Switched off, or a daily task or achievement past its end date"
        >
          {retiredTab.length === 0 ? (
            <Text size="small" className="text-ui-fg-subtle px-5 pb-4">
              Nothing retired.
            </Text>
          ) : (
            <ul className={rowsClass}>{retiredTab.map(listRow)}</ul>
          )}
        </WeekSection>
      ) : (
        <>
          {inWeek.length === 0 ? (
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
              {!past &&
                flagged(inWeek).length > 0 &&
                issueStrip(flagged(inWeek))}
              {!past && flagged(inWeek).length === 0 && (
                <Container className="flex items-center gap-x-2 px-5 py-2.5">
                  <CheckCircleSolid className="text-ui-tag-green-icon" />
                  <Text size="small" className="text-ui-fg-subtle">
                    Every task this week matches its name.
                  </Text>
                </Container>
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
                  {checkins.length > 0 && (
                    <details className="mt-3" open={doubledDay}>
                      <summary className="text-ui-fg-subtle cursor-pointer text-sm font-medium">
                        {plural(
                          checkins.length,
                          'check-in task',
                          'check-in tasks',
                        )}
                      </summary>
                      <ul className="mt-1 grid gap-x-2 xl:grid-cols-2">
                        {checkins.map(weeklyRow)}
                      </ul>
                    </details>
                  )}
                </div>
              </WeekSection>

              {pulls.length > 0 && (
                <WeekSection
                  title="Pull a Pokémon"
                  meta={weekMeta(
                    pulls.length,
                    tickets > 0 ? `up to ${tickets} tickets` : null,
                  )}
                  onAdd={
                    past
                      ? undefined
                      : () => openNew({ reqType: 'vault_pixel_count' })
                  }
                >
                  <ul className={rowsClass}>{pulls.map(weeklyRow)}</ul>
                </WeekSection>
              )}
              {rips.length > 0 && (
                <WeekSection
                  title="Rip packs"
                  meta={weekMeta(
                    rips.length,
                    freeRips > 0
                      ? `up to ${money(freeRips)} in free rips`
                      : null,
                  )}
                  onAdd={
                    past ? undefined : () => openNew({ reqType: 'rip_count' })
                  }
                >
                  <ul className={rowsClass}>{rips.map(weeklyRow)}</ul>
                </WeekSection>
              )}
              {topups.length > 0 && (
                <WeekSection
                  title="Top up"
                  meta={weekMeta(
                    topups.length,
                    credits > 0 ? `up to ${money(credits)} credit` : null,
                  )}
                  onAdd={
                    past ? undefined : () => openNew({ reqType: 'topup_myr' })
                  }
                >
                  <ul className={rowsClass}>{topups.map(weeklyRow)}</ul>
                </WeekSection>
              )}
              {others.length > 0 && (
                <WeekSection title="Other">
                  <ul className={rowsClass}>{others.map(weeklyRow)}</ul>
                </WeekSection>
              )}
            </>
          )}
          {retiredNow.length > 0 && (
            <WeekSection title={past ? 'Retired since' : 'Retired this week'}>
              <ul className={rowsClass}>{retiredNow.map(weeklyRow)}</ul>
            </WeekSection>
          )}
        </>
      )}
    </div>
  );
};

export default TasksPage;
