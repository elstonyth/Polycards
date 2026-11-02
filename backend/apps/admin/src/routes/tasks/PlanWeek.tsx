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
  goalAmount,
  nameIssue,
  runsInWeek,
  sameGoal,
  shortPack,
  weekLabel,
} from './task-board';
import {
  draftFrom,
  draftToInput,
  draftToPayload,
  issueFixes,
  issueText,
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
import { rewardWords } from './task-words';

interface PlanRow {
  source: AdminTaskDefinition;
  draft: Draft;
  keep: boolean;
  /** A person has answered this row's mismatch. */
  decided: boolean;
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
    view: r.source.view && {
      ...r.source.view,
      goal_name: r.draft.goal.name,
      goal_image: r.draft.goal.image,
      goal_price_myr: r.draft.goal.price,
    },
  };
};

const GROUPS: [string, string][] = [
  ['checkin_days', 'Check-in'],
  ['vault_pixel_count', 'Pull a Pokémon'],
  ['rip_count', 'Rip packs'],
  ['topup_myr', 'Top up'],
];

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

  // What the target week already holds is left out, so opening this twice, or
  // again after a publish stopped halfway, can't make the same task twice.
  const already = tasks.filter(
    (t) => t.kind === 'weekly' && runsInWeek(t, target),
  );
  const [rows, setRows] = useState<PlanRow[]>(() =>
    tasks
      .filter(
        (t) =>
          t.kind === 'weekly' &&
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
        },
        keep: true,
        decided: false,
      })),
  );
  const issueOf = (r: PlanRow) => (r.decided ? null : nameIssue(r.source));
  const needsCatalog = rows.some((r) => issueOf(r)?.kind === 'any');
  const { data: packs } = usePacks({ enabled: needsCatalog });

  const update = (id: string, patch: Partial<PlanRow>) =>
    setRows((all) =>
      all.map((r) => (r.source.id === id ? { ...r, ...patch } : r)),
    );
  const setDraft = (r: PlanRow, patch: Partial<Draft>) =>
    update(r.source.id, {
      draft: { ...r.draft, ...patch },
      // Typing the number the name says settles it just as a button would.
      decided:
        r.decided ||
        ('reqN' in patch &&
          issueOf(r)?.kind === 'count' &&
          Number(patch.reqN) === (issueOf(r) as { says: number }).says),
    });
  const decide = (r: PlanRow, fix: IssueFix) =>
    update(r.source.id, {
      draft: fix.patch ? fix.patch(r.draft) : r.draft,
      decided: true,
    });

  const kept = rows.filter((r) => r.keep);
  const undecided = kept.filter((r) => issueOf(r));
  const shown = kept.map(shownRow);
  const invalid = kept.some((r) => !draftToInput(r.draft, 'check'));
  const canPublish =
    kept.length > 0 &&
    undecided.length === 0 &&
    !invalid &&
    reason.trim() !== '' &&
    !publish.isPending;

  const submit = () => {
    const window = {
      starts_at: new Date(target).toISOString(),
      ends_at: new Date(addWeeks(target, 1)).toISOString(),
    };
    const inputs = kept.flatMap((r) => {
      const input = draftToInput(r.draft, reason.trim());
      return input ? [{ ...input, ...window }] : [];
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
          // The list refetches, so reopening offers only what didn't land.
          toast.error(`Stopped after ${saved} saved: ${e.message}`);
          onClose();
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
                : `Publish ${kept.length} tasks`}
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
                    {undecided.length > 0
                      ? `${undecided.length} ${undecided.length === 1 ? 'decision' : 'decisions'} left.`
                      : rows.length > 0
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
                {weekLabel(target)} already has {already.length}{' '}
                {already.length === 1 ? 'task' : 'tasks'}, so anything the same
                is left out here.
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
                  <CheckInTrack rows={shown} />
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
                      const editableN = type !== 'checkin_days';
                      const changed =
                        goalAmount(t.requirement) !==
                          goalAmount(r.source.requirement) ||
                        t.tickets !== r.source.tickets ||
                        t.reward.amount_myr !== r.source.reward.amount_myr;
                      return (
                        <li
                          key={r.source.id}
                          className={clx(
                            'rounded-lg px-2 py-2',
                            issue && 'bg-ui-tag-orange-bg xl:col-span-2',
                          )}
                        >
                          <div
                            className={`grid grid-cols-[20px_44px_minmax(0,1fr)] items-center gap-x-3 sm:grid-cols-[20px_44px_minmax(0,1fr)_1px_36px_minmax(120px,0.8fr)] ${r.keep ? '' : 'opacity-40'}`}
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
                                      : type === 'rip_count'
                                        ? 'Rip'
                                        : 'Pull'}
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
                                  {type !== 'topup_myr' && (
                                    <Text as="span" size="small">
                                      ×{' '}
                                      {(r.draft.goal.name
                                        ? shortPack(r.draft.goal.name)
                                        : null) ??
                                        (type === 'rip_count'
                                          ? 'any pack'
                                          : 'any Pokémon')}
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
                            </div>
                          </div>
                          {issue && (
                            <div className="mt-2 ml-[32px] flex flex-wrap items-center gap-2 sm:ml-[88px]">
                              <Text
                                size="small"
                                className="text-ui-tag-orange-text min-w-0 flex-[1_1_220px]"
                              >
                                {issueText(r.source, issue).headline}
                              </Text>
                              {issueFixes(r.source, issue, packs ?? [])
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
                                  update(r.source.id, {
                                    keep: false,
                                    decided: true,
                                  })
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
