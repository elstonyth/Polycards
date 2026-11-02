// Next week starts as a copy of this one, so nothing is retyped: rows typed by
// hand one at a time are how a name and its rule drift apart. A row that matches
// gets its name rewritten from its rule on the way over; a real mismatch waits
// for a person before anything can publish.
import { useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  Container,
  FocusModal,
  Input,
  Text,
  clx,
  toast,
} from '@medusajs/ui';
import {
  usePacks,
  usePublishTasks,
  type AdminTaskDefinition,
} from '../../lib/queries';
import { Field } from '../../components/form-bits';
import {
  addWeeks,
  copiedWindow,
  goalAmount,
  nameIssue,
  runsInWeek,
  sameGoal,
  sameTarget,
  shortPack,
  weekLabel,
} from './task-board';
import {
  REQUIREMENT_TYPES,
  draftFrom,
  draftMissing,
  draftToInput,
  draftToPayload,
  issueFixes,
  issueText,
  windowLabel,
  type Draft,
  type IssueFix,
} from './task-draft';
import {
  CheckInTrack,
  GoalArt,
  GoalLine,
  Perforation,
  RewardArt,
} from './TaskBoard';
import { goalWords, rewardWords } from './task-words';

interface PlanRow {
  source: AdminTaskDefinition;
  draft: Draft;
  keep: boolean;
  /** A person has answered this row's mismatch. */
  decided: boolean;
  /** Where the copy runs, shifted a week from the source. */
  window: ReturnType<typeof copiedWindow>;
  /** The week has a task on this same pack or Pokémon, at another count. */
  similar: boolean;
}

/** The row as it would save, so the shared display code can draw it. */
const shownRow = (r: PlanRow): AdminTaskDefinition => {
  const payload = draftToPayload(r.draft);
  return {
    ...r.source,
    id: `plan-${r.source.id}`,
    claims: 0,
    requirement: payload?.requirement ?? r.source.requirement,
    reward: payload?.reward ?? r.source.reward,
    tickets: payload?.tickets ?? r.source.tickets,
    starts_at: r.window.starts_at,
    ends_at: r.window.ends_at,
    view: r.source.view && {
      ...r.source.view,
      goal_name: r.draft.goal.name,
      goal_image: r.draft.goal.image,
      goal_price_myr: r.draft.goal.price,
      goal_buyable: r.draft.goal.buyable,
    },
  };
};

const GROUPS: [string, string][] = [
  ['checkin_days', 'Check-in'],
  ['vault_pixel_count', 'Pull a Pokémon'],
  ['rip_count', 'Rip packs'],
  ['topup_myr', 'Top up'],
];

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

export const PlanWeek = ({
  tasks,
  sourceWeek,
  onClose,
}: {
  tasks: AdminTaskDefinition[];
  sourceWeek: number;
  onClose: () => void;
}) => {
  const target = addWeeks(sourceWeek, 1);
  const publish = usePublishTasks();
  const [progress, setProgress] = useState(0);
  const [reason, setReason] = useState(`Week of ${weekLabel(target)} tasks`);

  // A row saved with changes no longer matches its source, so the same-goal check
  // alone can't tell it was already copied. If the target week has anything in it
  // already, copies start unticked: nothing goes in twice unless someone says so.
  const already = tasks.filter(
    (t) => t.kind === 'weekly' && runsInWeek(t, target),
  );
  const [rows, setRows] = useState<PlanRow[]>(() =>
    tasks
      .filter(
        (t) =>
          t.kind === 'weekly' &&
          REQUIREMENT_TYPES.weekly.includes(String(t.requirement.type)) &&
          runsInWeek(t, sourceWeek) &&
          !already.some((a) => sameGoal(a, t)),
      )
      .map((source) => ({
        source,
        draft: {
          ...draftFrom(source),
          id: undefined,
          active: true,
          startsAt: '',
          endsAt: '',
          saved: undefined,
        },
        keep: already.length === 0,
        decided: false,
        window: copiedWindow(source, sourceWeek),
        similar: already.some((a) => sameTarget(a, source)),
      })),
  );
  const issueOf = (r: PlanRow) => (r.decided ? null : nameIssue(r.source));
  const needsCatalog = rows.some((r) => issueOf(r)?.kind === 'any');
  const { data: packs } = usePacks({ enabled: needsCatalog });

  const update = (id: string, patch: Partial<PlanRow>) =>
    setRows((all) =>
      all.map((r) => (r.source.id === id ? { ...r, ...patch } : r)),
    );
  const setDraft = (r: PlanRow, patch: Partial<Draft>) => {
    const issue = issueOf(r);
    update(r.source.id, {
      draft: { ...r.draft, ...patch },
      // Typing the number the name says settles it just as a button would.
      decided:
        r.decided ||
        ('reqN' in patch &&
          issue?.kind === 'count' &&
          Number(patch.reqN) === issue.says),
    });
  };
  const decide = (r: PlanRow, fix: IssueFix) =>
    update(r.source.id, {
      draft: fix.patch ? fix.patch(r.draft) : r.draft,
      decided: true,
    });

  const kept = rows.filter((r) => r.keep);
  const undecided = kept.filter((r) => issueOf(r));
  const broken = kept.filter((r) => draftMissing(r.draft).length > 0);
  const shown = kept.map(shownRow);
  const reasonOk = reason.trim() !== '';
  const canPublish =
    kept.length > 0 &&
    undecided.length === 0 &&
    broken.length === 0 &&
    reasonOk &&
    !publish.isPending;

  const waitingOn = [
    undecided.length > 0 &&
      plural(undecided.length, 'decision', 'decisions') + ' left.',
    broken.length > 0 &&
      plural(broken.length, 'row needs', 'rows need') +
        ' fixing or leaving out.',
    !reasonOk && 'A reason is needed.',
    kept.length === 0 && rows.length > 0 && 'Nothing ticked yet.',
  ].filter(Boolean);

  const submit = () => {
    const sending = kept;
    const inputs = sending.flatMap((r) => {
      const input = draftToInput(r.draft, reason.trim());
      return input
        ? [
            {
              ...input,
              starts_at: r.window.starts_at,
              ends_at: r.window.ends_at,
            },
          ]
        : [];
    });
    let saved = 0;
    publish.mutate(
      {
        tasks: inputs,
        onProgress: (n) => {
          saved = n;
          setProgress(n);
        },
      },
      {
        onSuccess: () => {
          toast.success(
            `${inputs.length} tasks scheduled for ${weekLabel(target)}.`,
          );
          onClose();
        },
        onError: (e) => {
          // Stay open with what's left, edits intact, so Publish sends only the rest.
          toast.error(
            `Stopped after ${saved} saved: ${e.message}. Publish again to send the rest.`,
          );
          const done = new Set(sending.slice(0, saved).map((r) => r.source.id));
          setRows((all) => all.filter((r) => !done.has(r.source.id)));
          setProgress(0);
        },
      },
    );
  };

  return (
    <FocusModal
      open
      onOpenChange={(o) => !o && !publish.isPending && onClose()}
    >
      <FocusModal.Content>
        <FocusModal.Header>
          <div className="flex items-center gap-x-2">
            <Button
              size="small"
              variant="secondary"
              disabled={publish.isPending}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              size="small"
              onClick={submit}
              isLoading={publish.isPending}
              disabled={!canPublish}
            >
              {publish.isPending
                ? `Publishing ${progress} of ${kept.length}`
                : `Publish ${plural(kept.length, 'task', 'tasks')}`}
            </Button>
          </div>
        </FocusModal.Header>
        <FocusModal.Body className="pc-admin bg-ui-bg-subtle overflow-auto">
          <div className="mx-auto flex max-w-[1160px] flex-col gap-y-3 p-4 sm:p-6">
            <Container className="flex flex-wrap items-end justify-between gap-4 px-6 py-4">
              <div>
                <FocusModal.Title asChild>
                  <Text size="large" weight="plus">
                    Plan {weekLabel(target)}
                  </Text>
                </FocusModal.Title>
                <FocusModal.Description asChild>
                  <Text size="small" className="text-ui-fg-subtle mt-0.5">
                    Copied from {weekLabel(sourceWeek)}, so nothing needs
                    retyping. Goes live Monday at 12 AM, Malaysia time.{' '}
                    {waitingOn.length > 0
                      ? waitingOn.join(' ')
                      : canPublish
                        ? 'Ready.'
                        : ''}
                  </Text>
                </FocusModal.Description>
              </div>
              <Field
                label="Reason, recorded for every task"
                htmlFor="plan-reason"
                className="w-full sm:w-64"
              >
                <Input
                  id="plan-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
            </Container>

            {already.length > 0 && (
              <Text size="small" className="text-ui-fg-subtle px-1">
                {weekLabel(target)} already has{' '}
                {plural(already.length, 'task', 'tasks')}, so anything the same
                is left out, and the rest start unticked. Tick what you still
                want to add.
              </Text>
            )}

            {rows.length === 0 ? (
              <Container className="px-6 py-8 text-center">
                <Text size="small" className="text-ui-fg-subtle">
                  Nothing left to copy from {weekLabel(sourceWeek)}.
                </Text>
              </Container>
            ) : (
              <Container className="p-0">
                <div className="px-5 pt-3.5 pb-2.5">
                  <Text size="small" weight="plus">
                    Check-in week
                  </Text>
                </div>
                <div className="px-5 pb-4">
                  <CheckInTrack rows={[...shown, ...already]} />
                </div>
              </Container>
            )}

            {GROUPS.map(([type, title]) => {
              const group = rows.filter(
                (r) => r.source.requirement.type === type,
              );
              if (group.length === 0) return null;
              return (
                <Container key={type} className="p-0">
                  <div className="px-5 pt-3.5 pb-1">
                    <Text size="small" weight="plus">
                      {title}
                    </Text>
                  </div>
                  <ul className="grid gap-x-2 p-2 xl:grid-cols-2">
                    {group.map((r) => {
                      const t = shownRow(r);
                      const issue = r.keep ? issueOf(r) : null;
                      const problem = r.keep
                        ? draftMissing(r.draft)[0]?.label
                        : undefined;
                      const editableN = type !== 'checkin_days';
                      const changed =
                        goalAmount(t.requirement) !==
                          goalAmount(r.source.requirement) ||
                        t.tickets !== r.source.tickets ||
                        t.reward.amount_myr !== r.source.reward.amount_myr;
                      const what = goalWords(t).what;
                      const extra = rewardWords(t).sub;
                      return (
                        <li
                          key={r.source.id}
                          className={clx(
                            'rounded-lg px-2 py-2',
                            (issue || problem) &&
                              'bg-ui-tag-orange-bg xl:col-span-2',
                          )}
                        >
                          <div
                            className={clx(
                              'grid grid-cols-[20px_44px_minmax(0,1fr)] items-center gap-x-3 sm:grid-cols-[20px_44px_minmax(0,1fr)_1px_36px_minmax(120px,0.8fr)]',
                              !r.keep && 'opacity-40',
                            )}
                          >
                            <Checkbox
                              aria-label={`Keep: ${r.source.title}`}
                              checked={r.keep}
                              onCheckedChange={(v) =>
                                update(r.source.id, { keep: v === true })
                              }
                            />
                            <GoalArt t={t} />
                            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                              {editableN ? (
                                <>
                                  <Text as="span" size="small">
                                    {type === 'topup_myr'
                                      ? 'Top up RM'
                                      : goalWords(t).verb}
                                  </Text>
                                  <Input
                                    size="small"
                                    type="number"
                                    min={1}
                                    aria-label="Amount"
                                    className="w-[70px] text-center"
                                    value={r.draft.reqN}
                                    onChange={(e) =>
                                      setDraft(r, { reqN: e.target.value })
                                    }
                                  />
                                  {what && (
                                    <Text as="span" size="small">
                                      × {shortPack(what)}
                                    </Text>
                                  )}
                                </>
                              ) : (
                                <Text as="span" size="small">
                                  <GoalLine t={t} />
                                </Text>
                              )}
                              {changed && (
                                <Badge size="2xsmall" color="green">
                                  Changed
                                </Badge>
                              )}
                              {r.window.short && (
                                <Text
                                  as="span"
                                  size="xsmall"
                                  className="text-ui-fg-muted w-full tabular-nums"
                                >
                                  Runs {windowLabel(r.window)}
                                </Text>
                              )}
                              {r.similar && (
                                <Text
                                  as="span"
                                  size="xsmall"
                                  className="text-ui-fg-muted w-full"
                                >
                                  {weekLabel(target)} already has a task on this
                                  at another count.
                                </Text>
                              )}
                            </div>
                            <span className="max-sm:hidden">
                              <Perforation />
                            </span>
                            <RewardArt t={t} />
                            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 max-sm:col-start-3 max-sm:mt-1">
                              {t.reward.type === 'tickets' ? (
                                <>
                                  <Input
                                    size="small"
                                    type="number"
                                    min={1}
                                    aria-label="Tickets"
                                    className="w-[70px] text-center"
                                    value={r.draft.tickets}
                                    onChange={(e) =>
                                      setDraft(r, { tickets: e.target.value })
                                    }
                                  />
                                  <Text as="span" size="small">
                                    tickets
                                  </Text>
                                </>
                              ) : t.reward.type === 'credit' ? (
                                <>
                                  <Text as="span" size="small">
                                    RM
                                  </Text>
                                  <Input
                                    size="small"
                                    type="number"
                                    min={1}
                                    aria-label="Credit"
                                    className="w-[70px] text-center"
                                    value={r.draft.rewardValue}
                                    onChange={(e) =>
                                      setDraft(r, {
                                        rewardValue: e.target.value,
                                      })
                                    }
                                  />
                                  <Text as="span" size="small">
                                    credit
                                  </Text>
                                </>
                              ) : (
                                <Text as="span" size="small" leading="compact">
                                  {rewardWords(t).main}
                                </Text>
                              )}
                              {extra && (
                                <Text
                                  as="span"
                                  size="xsmall"
                                  className="text-ui-fg-muted w-full tabular-nums"
                                >
                                  {extra}
                                </Text>
                              )}
                            </div>
                          </div>
                          {(issue || problem) && (
                            <div className="mt-2 ml-[32px] flex flex-wrap items-center gap-2 sm:ml-[88px]">
                              <Text
                                size="small"
                                className="text-ui-tag-orange-text min-w-0 flex-[1_1_220px]"
                              >
                                {issue
                                  ? issueText(r.source, issue).headline
                                  : `Needs ${problem}. Fix it here, or after publishing leave it out and add it with New task.`}
                              </Text>
                              {issue &&
                                issueFixes(r.source, issue, packs ?? [])
                                  .filter((fix) => fix.action === 'patch')
                                  .map((fix) => (
                                    <Button
                                      key={fix.label}
                                      size="small"
                                      variant="secondary"
                                      onClick={() => decide(r, fix)}
                                    >
                                      {fix.label}
                                    </Button>
                                  ))}
                              <Button
                                size="small"
                                variant="transparent"
                                onClick={() =>
                                  update(r.source.id, { keep: false })
                                }
                              >
                                Leave it out
                              </Button>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </Container>
              );
            })}
          </div>
        </FocusModal.Body>
      </FocusModal.Content>
    </FocusModal>
  );
};
