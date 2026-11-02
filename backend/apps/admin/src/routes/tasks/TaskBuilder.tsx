// New and edit, as one sentence: "Every week, when a player pulls 2 × Mew, they
// get 20 tickets." Each part is a button that opens its own small picker, and the
// name, the player's card and the checks all follow the sentence. Nothing starts
// filled in, so a part left alone can't quietly become the rule.
import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Checkbox,
  FocusModal,
  Input,
  Label,
  Select,
  Switch,
  Text,
  clx,
  toast,
  usePrompt,
} from '@medusajs/ui';
import {
  Calendar,
  CheckCircleSolid,
  CreditCard,
  ExclamationCircle,
  InformationCircle,
  Sparkles,
  Star,
  Trophy,
} from '@medusajs/icons';
import {
  useCards,
  usePacks,
  usePixelPokemon,
  useSaveTaskDefinition,
  useVipLevels,
  type AdminTaskDefinition,
} from '../../lib/queries';
import { resolveImageUrl } from '../../lib/image-url';
import { Field } from '../../components/form-bits';
import { money, taskName } from './task-board';
import {
  ANY,
  KIND_LABEL,
  NO_GOAL,
  NO_PRIZE,
  REQUIREMENT_TYPES,
  countApplies,
  draftChecks,
  draftMissing,
  draftParts,
  draftToInput,
  needsAnyConfirm,
  scheduleOk,
  type BuilderStep,
  type Draft,
} from './task-draft';
import { PlayerPreview } from './PlayerPreview';
import { COINS_ART, TICKET_ART } from './task-words';

type Step = BuilderStep | 'done';

// How many search results a picker draws before asking for a narrower search.
const PIXEL_SHOWN = 40;
const CARDS_SHOWN = 24;

const firstMissing = (d: Draft): Step => draftMissing(d)[0]?.step ?? 'done';

const goalTile = (
  type: string,
  kind: Draft['kind'],
): { title: string; hint: string; icon: React.ReactNode } => {
  const lifetime = kind === 'achievement';
  switch (type) {
    case 'vault_pixel_count':
      return lifetime
        ? {
            title: 'Vault a Pokémon',
            hint: 'Cards ever vaulted, from any source',
            icon: <Star />,
          }
        : {
            title: 'Pull a Pokémon',
            hint: 'Paid pulls, graded or not',
            icon: <Star />,
          };
    case 'rip_count':
      return {
        title: 'Rip packs',
        hint: 'Paid rips of a pack you pick',
        icon: <Sparkles />,
      };
    case 'checkin_days':
      return {
        title: 'Check in',
        hint:
          kind === 'daily' ? 'Checking in today' : 'Days checked in this week',
        icon: <Calendar />,
      };
    case 'topup_myr':
      return {
        title: 'Top up',
        hint: lifetime ? 'Real top-ups, all time' : 'Real top-ups only',
        icon: <CreditCard />,
      };
    case 'reach_level':
      return {
        title: 'Reach a VIP level',
        hint: 'Their highest level ever',
        icon: <Trophy />,
      };
    default:
      return {
        title: 'Vault cards',
        hint: 'Cards ever vaulted',
        icon: <Star />,
      };
  }
};

const defaultReason = (kind: Draft['kind'], weekText: string): string =>
  kind === 'weekly'
    ? `Week of ${weekText} tasks`
    : kind === 'daily'
      ? 'New daily task'
      : 'New achievement';

const Chip = ({
  label,
  filled,
  current,
  warn,
  onClick,
}: {
  label: string;
  filled: boolean;
  current: boolean;
  warn?: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-current={current ? 'step' : undefined}
    className={clx(
      'mx-px inline-block rounded-md px-2.5 py-0.5 align-baseline font-medium transition-colors',
      filled && !warn
        ? 'bg-ui-bg-component hover:bg-ui-bg-component-hover shadow-[inset_0_0_0_1px_var(--border-base)]'
        : 'bg-ui-tag-orange-bg text-ui-tag-orange-text shadow-[inset_0_0_0_1px_var(--tag-orange-border)]',
      current && '!shadow-[inset_0_0_0_2px_var(--fg-base)]',
    )}
  >
    {label}
  </button>
);

const Tile = ({
  title,
  hint,
  icon,
  pressed,
  onClick,
}: {
  title: string;
  hint: string;
  icon: React.ReactNode;
  pressed: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={pressed}
    className={clx(
      'bg-ui-bg-base hover:bg-ui-bg-base-hover shadow-elevation-card-rest flex min-h-24 flex-col gap-y-1 rounded-lg p-3 text-left transition-colors',
      pressed && '!shadow-[inset_0_0_0_2px_var(--fg-base)]',
    )}
  >
    <span className="text-ui-fg-subtle">{icon}</span>
    <Text size="small" weight="plus" leading="compact">
      {title}
    </Text>
    <Text size="xsmall" leading="compact" className="text-ui-fg-muted">
      {hint}
    </Text>
  </button>
);

interface ArtItem {
  key: string;
  label: string;
  sub?: string;
  image: string | null;
  pressed: boolean;
  onClick: () => void;
}

const ArtGrid = ({ items, pixel }: { items: ArtItem[]; pixel?: boolean }) => (
  <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2">
    {items.map((it) => (
      <button
        key={it.key}
        type="button"
        onClick={it.onClick}
        aria-pressed={it.pressed}
        className={clx(
          'bg-ui-bg-base hover:bg-ui-bg-base-hover shadow-elevation-card-rest flex flex-col items-center gap-y-0.5 rounded-lg px-1 py-2 text-center transition-colors',
          it.pressed && '!shadow-[inset_0_0_0_2px_var(--fg-base)]',
        )}
      >
        {it.image ? (
          <img
            src={resolveImageUrl(it.image)}
            alt=""
            loading="lazy"
            className={clx(
              'h-14 w-14 object-contain',
              pixel && '[image-rendering:pixelated]',
            )}
          />
        ) : (
          <span className="h-14 w-14" />
        )}
        <Text size="xsmall" leading="compact">
          {it.label}
        </Text>
        {it.sub && (
          <Text size="xsmall" leading="compact" className="text-ui-fg-muted">
            {it.sub}
          </Text>
        )}
      </button>
    ))}
  </div>
);

const AnyRow = ({
  title,
  hint,
  pressed,
  disabled,
  onClick,
}: {
  title: string;
  hint: string;
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-pressed={pressed}
    className={clx(
      'hover:bg-ui-bg-base-hover mt-2 flex w-full items-center gap-x-3 rounded-lg border border-dashed px-3 py-2.5 text-left transition-colors disabled:opacity-50',
      pressed
        ? 'bg-ui-tag-orange-bg border-ui-tag-orange-border'
        : 'border-ui-border-strong',
    )}
  >
    <Sparkles className="text-ui-fg-subtle shrink-0" />
    <span>
      <Text size="small" weight="plus" leading="compact">
        {title}
      </Text>
      <Text size="xsmall" leading="compact" className="text-ui-fg-subtle">
        {hint}
      </Text>
    </span>
  </button>
);

/** A picker's loading, failed and nothing-found states, one line each. */
const PickerNote = ({
  what,
  loading,
  failed,
  empty,
  onRetry,
}: {
  what: string;
  loading: boolean;
  failed: boolean;
  empty: boolean;
  onRetry: () => void;
}) => {
  if (loading) {
    return (
      <Text size="small" className="text-ui-fg-subtle">
        Loading {what}…
      </Text>
    );
  }
  if (failed) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Text size="small" className="text-ui-fg-error">
          Couldn't load {what}.
        </Text>
        <Button size="small" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  return empty ? (
    <Text size="small" className="text-ui-fg-subtle">
      No {what} found.
    </Text>
  ) : null;
};

const Numbers = ({
  value,
  quick,
  format = String,
  placeholder,
  onPick,
  onType,
  onDone,
}: {
  value: string;
  quick: number[];
  format?: (n: number) => string;
  placeholder: string;
  onPick: (n: number) => void;
  onType: (v: string) => void;
  onDone: () => void;
}) => (
  <div className="flex flex-wrap items-center gap-1.5">
    {quick.map((n) => (
      <Button
        key={n}
        size="small"
        variant={value === String(n) ? 'primary' : 'secondary'}
        aria-pressed={value === String(n)}
        onClick={() => onPick(n)}
      >
        {format(n)}
      </Button>
    ))}
    <Input
      type="number"
      min={1}
      aria-label={placeholder}
      placeholder={placeholder}
      className="w-28"
      // The box always shows what's stored. Blanking it when the value matched a
      // quick button threw away the digits typed so far: 15 became 5.
      value={value === '0' ? '' : value}
      onChange={(e) => onType(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && onDone()}
    />
    {value !== '' && value !== '0' && !quick.map(String).includes(value) && (
      <Button size="small" variant="secondary" onClick={onDone}>
        Next
      </Button>
    )}
  </div>
);

export const TaskBuilder = ({
  initial,
  claims,
  weekRows,
  weekText,
  weekWindow,
  onClose,
}: {
  initial: Draft;
  /** Claims already made on the row being edited. */
  claims: number;
  /** What the week being worked on already holds, for the clash checks. */
  weekRows: AdminTaskDefinition[];
  weekText: string;
  /** That week, as form values. A new weekly task runs there. */
  weekWindow: { startsAt: string; endsAt: string };
  onClose: () => void;
}) => {
  const save = useSaveTaskDefinition();
  const prompt = usePrompt();
  const [d, setD] = useState(initial);
  const [step, setStep] = useState<Step>(firstMissing(initial));
  const [reason, setReason] = useState(
    initial.id ? '' : defaultReason(initial.kind, weekText),
  );
  const [reasonEdited, setReasonEdited] = useState(false);
  const [anyOk, setAnyOk] = useState(false);
  // A half-typed date reads as '' from the input, the same as no date, so the
  // browser's own flag is the only way to tell them apart.
  const [badDate, setBadDate] = useState({ starts: false, ends: false });
  const [pixelInput, setPixelInput] = useState('');
  const [pixelQuery, setPixelQuery] = useState('');
  const [cardQuery, setCardQuery] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setPixelQuery(pixelInput.trim()), 250);
    return () => clearTimeout(timer);
  }, [pixelInput]);

  // Picking unmounts the button that had focus. Move on to the next picker, so a
  // keyboard or screen-reader user isn't dropped back at the top of the page.
  const pickerRef = useRef<HTMLDivElement>(null);
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    pickerRef.current?.focus();
  }, [step]);

  const locked = Boolean(d.id);
  const needsPacks =
    (d.reqType === 'rip_count' && step === 'target') ||
    (d.rewardType === 'pack' && step === 'value');
  const packsQuery = usePacks({ enabled: needsPacks });
  const cardsQuery = useCards({
    enabled: d.rewardType === 'card' && step === 'value',
  });
  const vipQuery = useVipLevels();
  const pixelsQuery = usePixelPokemon(
    { q: pixelQuery, limit: 200 },
    { enabled: d.reqType === 'vault_pixel_count' && step === 'target' },
  );

  // A pick moves on to the next blank part, so the sentence fills itself in order.
  const set = (patch: Partial<Draft>) => {
    const next = { ...d, ...patch };
    setD(next);
    setStep(firstMissing(next));
  };
  // A new goal type starts clean. Nothing from the old goal carries over.
  const pickGoal = (reqType: string) => {
    if (reqType === d.reqType) return setStep(firstMissing(d));
    setAnyOk(false);
    set({
      reqType,
      reqN: d.kind === 'daily' && reqType === 'checkin_days' ? '1' : '',
      reqPack: '',
      reqPixel: '',
      goal: NO_GOAL,
    });
  };
  const pickKind = (kind: Draft['kind']) => {
    if (kind === d.kind) return setStep(firstMissing(d));
    const allowed = REQUIREMENT_TYPES[kind].includes(d.reqType);
    if (!reasonEdited) setReason(defaultReason(kind, weekText));
    set({
      kind,
      startsAt: kind === 'weekly' ? weekWindow.startsAt : '',
      endsAt: kind === 'weekly' ? weekWindow.endsAt : '',
      ...(allowed
        ? // A daily check-in's hidden 1 must not become a weekly goal nobody chose.
          d.reqType === 'checkin_days'
          ? { reqN: kind === 'daily' ? '1' : '' }
          : {}
        : { reqType: '', reqN: '', reqPack: '', reqPixel: '', goal: NO_GOAL }),
    });
  };
  const pickReward = (rewardType: Draft['rewardType']) => {
    if (rewardType === d.rewardType) return setStep(firstMissing(d));
    set({
      rewardType,
      rewardValue: '',
      // A tickets reward's count is its whole payout. Anything else keeps the
      // tickets it pays on top.
      tickets:
        d.rewardType === 'tickets' || rewardType === 'tickets'
          ? '0'
          : d.tickets,
      prize: NO_PRIZE,
    });
  };

  const packs = packsQuery.data ?? [];
  const onSale = packs
    .filter(
      (p) =>
        p.status === 'active' &&
        p.in_stock !== false &&
        p.price > 0 &&
        p.category !== 'reward_box' &&
        p.category !== 'free_welcome',
    )
    .sort((a, b) => a.price - b.price);
  const onSaleSlugs = new Set(onSale.map((p) => p.slug));
  const notOnSale = packs.filter((p) => !onSaleSlugs.has(p.slug));
  const cheapest = onSale[0];

  const input = draftToInput(d, reason.trim());
  const missing = draftMissing(d);
  const anyWaiting = needsAnyConfirm(d) && !anyOk;
  const scheduleValid = scheduleOk(d) && !badDate.starts && !badDate.ends;
  const ready =
    Boolean(input) && !anyWaiting && scheduleValid && reason.trim() !== '';
  // Everything that keeps Save grey and isn't part of the sentence itself.
  const blockers = [
    missing.length === 0 && anyWaiting && 'Tick the any-pack box below.',
    !scheduleValid &&
      'The dates in More options need fixing: finish typing them, and the end must be after the start.',
    reason.trim() === '' && 'A reason is needed.',
  ].filter(Boolean);

  const submit = () => {
    if (!input || !ready) return;
    save.mutate(input, {
      onSuccess: () => {
        toast.success(d.id ? 'Task updated.' : 'Task created.');
        onClose();
      },
      onError: (e) => toast.error(e.message),
    });
  };

  const dirty = JSON.stringify(d) !== JSON.stringify(initial);
  const requestClose = async () => {
    if (save.isPending) return;
    if (dirty) {
      const discard = await prompt({
        variant: 'danger',
        title: 'Discard this task?',
        description: "What you've filled in won't be saved.",
        confirmText: 'Discard',
        cancelText: 'Keep editing',
      });
      if (!discard) return;
    }
    onClose();
  };

  const n = Number(d.reqN);
  const hasPrize =
    d.rewardType === 'tickets'
      ? Number(d.tickets) >= 1
      : d.rewardType === 'credit'
        ? Number(d.rewardValue) > 0
        : d.rewardValue.trim() !== '' && Boolean(d.prize.name);
  const inViewedWeek =
    d.startsAt === weekWindow.startsAt && d.endsAt === weekWindow.endsAt;
  const runsText =
    d.kind === 'weekly' && inViewedWeek
      ? `Runs ${weekText}`
      : d.startsAt || d.endsAt
        ? `Runs ${d.startsAt.replace('T', ' ') || 'from now'} to ${d.endsAt.replace('T', ' ') || 'until retired'}`
        : 'Runs until retired';

  const chip = (
    s: BuilderStep,
    label: string,
    filled: boolean,
    warn = false,
  ) => (
    <Chip
      label={label}
      filled={filled}
      warn={warn}
      current={step === s}
      onClick={() => setStep(s)}
    />
  );

  const goalChips = () => {
    switch (d.reqType) {
      case 'vault_pixel_count':
      case 'rip_count': {
        const pull = d.reqType === 'vault_pixel_count';
        const scope = pull ? d.reqPixel : d.reqPack;
        const named = scope === ANY || (scope !== '' && Boolean(d.goal.name));
        const what =
          scope === ''
            ? pull
              ? 'which Pokémon?'
              : 'which pack?'
            : scope === ANY
              ? pull
                ? 'any Pokémon'
                : 'any pack'
              : (d.goal.name ?? 'pick again');
        return (
          <>
            {chip(
              'goal',
              pull ? (d.kind === 'achievement' ? 'vaults' : 'pulls') : 'rips',
              true,
            )}{' '}
            {chip('n', n > 0 ? String(n) : 'how many?', n > 0)} ×{' '}
            {chip('target', what, named, !pull && scope === ANY)}
          </>
        );
      }
      case 'checkin_days':
        return countApplies(d) ? (
          <>
            {chip('goal', 'checks in on', true)}{' '}
            {chip(
              'n',
              n > 0 ? `${n} ${n === 1 ? 'day' : 'days'}` : 'how many days?',
              n > 0,
            )}
          </>
        ) : (
          chip('goal', 'checks in', true)
        );
      case 'topup_myr':
        return (
          <>
            {chip('goal', 'tops up', true)}{' '}
            {chip('n', n > 0 ? money(n) : 'how much?', n > 0)}
          </>
        );
      case 'reach_level':
        return (
          <>
            {chip('goal', 'reaches VIP level', true)}{' '}
            {chip('n', n > 0 ? String(n) : 'which?', n > 0)}
          </>
        );
      case 'vault_count':
        return (
          <>
            {chip('goal', 'vaults', true)}{' '}
            {chip('n', n > 0 ? String(n) : 'how many?', n > 0)} cards
          </>
        );
      default:
        return chip('goal', 'does what?', false);
    }
  };

  const rewardChips = () => {
    const picked = d.prize.name ?? (d.rewardValue ? 'pick again' : null);
    switch (d.rewardType) {
      case 'tickets':
        return (
          <>
            {chip('value', hasPrize ? d.tickets : 'how many?', hasPrize)}{' '}
            {chip('reward', 'tickets', true)}
          </>
        );
      case 'credit':
        return (
          <>
            {chip(
              'value',
              hasPrize ? money(Number(d.rewardValue)) : 'how much?',
              hasPrize,
            )}{' '}
            {chip('reward', 'bonus credit', true)}
          </>
        );
      case 'pack':
        return (
          <>
            {chip('reward', 'a free rip of', true)}{' '}
            {chip('value', picked ?? 'which pack?', hasPrize)}
          </>
        );
      case 'card':
        return (
          <>
            {chip('reward', 'the card', true)}{' '}
            {chip('value', picked ?? 'which card?', hasPrize)}
          </>
        );
      default:
        return chip('reward', 'what?', false);
    }
  };

  const heading = (text: string) => (
    <Text size="small" weight="plus" className="mb-2.5">
      {text}
    </Text>
  );

  const packItem = (
    p: (typeof packs)[number],
    pressed: boolean,
    onClick: () => void,
  ): ArtItem => ({
    key: p.slug,
    label: p.title,
    sub: money(p.price),
    image: p.image,
    pressed,
    onClick,
  });

  const packsNote = (
    <PickerNote
      what="packs"
      loading={packsQuery.isLoading}
      failed={packsQuery.isError}
      empty={false}
      onRetry={() => packsQuery.refetch()}
    />
  );

  const picker = () => {
    switch (step) {
      case 'repeat':
        return (
          <>
            {heading('How often can a player earn it?')}
            {locked ? (
              <Text size="small" className="text-ui-fg-subtle">
                Locked once a task exists. Retire this one and make a new task
                to change it.
              </Text>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-2">
                <Tile
                  title="Every week"
                  hint="Resets Monday 12 AM"
                  icon={<Calendar />}
                  pressed={d.kind === 'weekly'}
                  onClick={() => pickKind('weekly')}
                />
                <Tile
                  title="Every day"
                  hint="Resets at midnight"
                  icon={<Calendar />}
                  pressed={d.kind === 'daily'}
                  onClick={() => pickKind('daily')}
                />
                <Tile
                  title="Once per account"
                  hint="One claim, ever"
                  icon={<Trophy />}
                  pressed={d.kind === 'achievement'}
                  onClick={() => pickKind('achievement')}
                />
              </div>
            )}
          </>
        );
      case 'goal':
        return (
          <>
            {heading('What does the player have to do?')}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-2">
              {REQUIREMENT_TYPES[d.kind].map((type) => {
                const tile = goalTile(type, d.kind);
                return (
                  <Tile
                    key={type}
                    title={tile.title}
                    hint={tile.hint}
                    icon={tile.icon}
                    pressed={d.reqType === type}
                    onClick={() => pickGoal(type)}
                  />
                );
              })}
            </div>
          </>
        );
      case 'n':
        if (d.reqType === 'checkin_days') {
          return (
            <>
              {heading('Which day of the check-in week?')}
              <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-7">
                {[1, 2, 3, 4, 5, 6, 7].map((day) => {
                  const taken = weekRows.filter(
                    (t) =>
                      t.id !== d.id &&
                      t.requirement.type === 'checkin_days' &&
                      Number(t.requirement.days) === day,
                  );
                  return (
                    <button
                      key={day}
                      type="button"
                      onClick={() => set({ reqN: String(day) })}
                      aria-pressed={n === day}
                      className={clx(
                        'bg-ui-bg-base hover:bg-ui-bg-base-hover shadow-elevation-card-rest flex flex-col items-center gap-y-0.5 rounded-lg px-0.5 py-2 text-center transition-colors',
                        n === day && '!shadow-[inset_0_0_0_2px_var(--fg-base)]',
                      )}
                    >
                      <Text size="small" weight="plus" leading="compact">
                        Day {day}
                      </Text>
                      <Text
                        size="xsmall"
                        leading="compact"
                        className={
                          taken.length
                            ? 'text-ui-tag-orange-text'
                            : 'text-ui-fg-muted'
                        }
                      >
                        {taken.length ? 'Has a reward' : 'Free'}
                      </Text>
                    </button>
                  );
                })}
              </div>
            </>
          );
        }
        if (d.reqType === 'reach_level') {
          return (
            <Field label="Which VIP level?" className="max-w-xs">
              <PickerNote
                what="VIP levels"
                loading={vipQuery.isLoading}
                failed={vipQuery.isError}
                empty={false}
                onRetry={() => vipQuery.refetch()}
              />
              <Select value={d.reqN} onValueChange={(reqN) => set({ reqN })}>
                <Select.Trigger aria-label="VIP level">
                  <Select.Value placeholder="Level" />
                </Select.Trigger>
                <Select.Content>
                  {(vipQuery.data?.levels ?? []).map((l) => (
                    <Select.Item key={l.level} value={String(l.level)}>
                      {l.level}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select>
            </Field>
          );
        }
        if (d.reqType === 'topup_myr') {
          return (
            <>
              {heading('How much do they top up?')}
              <Numbers
                value={d.reqN}
                quick={[100, 300, 500, 1000]}
                format={money}
                placeholder="Other RM"
                onPick={(v) => set({ reqN: String(v) })}
                onType={(reqN) => setD({ ...d, reqN })}
                onDone={() => setStep(firstMissing(d))}
              />
            </>
          );
        }
        return (
          <>
            {heading('How many?')}
            <Numbers
              value={d.reqN}
              quick={[1, 2, 5, 10, 50]}
              placeholder="Other"
              onPick={(v) => set({ reqN: String(v) })}
              onType={(reqN) => setD({ ...d, reqN })}
              onDone={() => setStep(firstMissing(d))}
            />
          </>
        );
      case 'target':
        if (d.reqType === 'vault_pixel_count') {
          const found = pixelsQuery.data?.pixel_pokemon ?? [];
          const shown = found.slice(0, PIXEL_SHOWN);
          const items: ArtItem[] = shown.map((p) => {
            const name =
              p.variant && p.variant !== 'normal'
                ? `${p.name} (${p.variant})`
                : p.name;
            return {
              key: p.id,
              label: name,
              sub: p.dex ? `#${p.dex}` : undefined,
              image: p.image_url,
              pressed: d.reqPixel === p.id,
              onClick: () =>
                set({
                  reqPixel: p.id,
                  goal: { name, image: p.image_url, price: null },
                }),
            };
          });
          // The one already chosen stays visible even when a search hides it.
          if (
            d.reqPixel &&
            d.reqPixel !== ANY &&
            d.goal.name &&
            !shown.some((p) => p.id === d.reqPixel)
          ) {
            items.unshift({
              key: d.reqPixel,
              label: d.goal.name,
              image: d.goal.image,
              pressed: true,
              onClick: () => setStep(firstMissing(d)),
            });
          }
          return (
            <>
              {heading('Which Pokémon?')}
              <Input
                aria-label="Search Pokémon"
                placeholder="Search Pokémon"
                className="mb-2.5 max-w-xs"
                value={pixelInput}
                onChange={(e) => setPixelInput(e.target.value)}
              />
              <PickerNote
                what="Pokémon"
                loading={pixelsQuery.isLoading}
                failed={pixelsQuery.isError}
                empty={!pixelsQuery.isLoading && found.length === 0}
                onRetry={() => pixelsQuery.refetch()}
              />
              <ArtGrid pixel items={items} />
              {found.length > PIXEL_SHOWN && (
                <Text size="xsmall" className="text-ui-fg-muted mt-2">
                  Showing {PIXEL_SHOWN} of{' '}
                  {pixelsQuery.data?.total ?? found.length}. Search to narrow it
                  down.
                </Text>
              )}
              <AnyRow
                title="Any Pokémon"
                hint="Every linked Pokémon card counts."
                pressed={d.reqPixel === ANY}
                onClick={() => set({ reqPixel: ANY, goal: NO_GOAL })}
              />
            </>
          );
        }
        return (
          <>
            {heading('Which pack?')}
            {packsNote}
            <ArtGrid
              items={onSale.map((p) =>
                packItem(p, d.reqPack === p.slug, () => {
                  setAnyOk(false);
                  set({
                    reqPack: p.slug,
                    goal: {
                      name: p.title,
                      image: p.image,
                      price: p.price,
                      buyable: true,
                    },
                  });
                }),
              )}
            />
            <AnyRow
              title="Any pack"
              hint={`Every paid rip counts${cheapest ? `, even a ${money(cheapest.price)} ${cheapest.title}` : ''}. Pick this only on purpose.`}
              pressed={d.reqPack === ANY}
              disabled={!packsQuery.data}
              onClick={() =>
                set({
                  reqPack: ANY,
                  goal: {
                    name: null,
                    image: null,
                    price: cheapest?.price ?? null,
                    buyable: null,
                  },
                })
              }
            />
            {notOnSale.some(
              (p) =>
                p.price > 0 &&
                p.category !== 'reward_box' &&
                p.category !== 'free_welcome',
            ) && (
              <>
                <Text size="xsmall" weight="plus" className="mt-4 mb-2">
                  Not on sale right now
                </Text>
                <ArtGrid
                  items={notOnSale
                    .filter(
                      (p) =>
                        p.price > 0 &&
                        p.category !== 'reward_box' &&
                        p.category !== 'free_welcome',
                    )
                    .map((p) =>
                      packItem(p, d.reqPack === p.slug, () => {
                        setAnyOk(false);
                        set({
                          reqPack: p.slug,
                          goal: {
                            name: p.title,
                            image: p.image,
                            price: p.price,
                            buyable: false,
                          },
                        });
                      }),
                    )}
                />
              </>
            )}
          </>
        );
      case 'reward':
        return (
          <>
            {heading('What do they get?')}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-2">
              <Tile
                title="Lucky Draw tickets"
                hint="Into their vault"
                icon={
                  <img
                    src={resolveImageUrl(TICKET_ART)}
                    alt=""
                    className="h-7 w-7 rounded bg-[#141416] object-contain p-0.5"
                  />
                }
                pressed={d.rewardType === 'tickets'}
                onClick={() => pickReward('tickets')}
              />
              <Tile
                title="A free rip"
                hint="Rolls the pack's live odds"
                icon={<Sparkles />}
                pressed={d.rewardType === 'pack'}
                onClick={() => pickReward('pack')}
              />
              <Tile
                title="Bonus credit"
                hint="RM, added to their balance"
                icon={
                  <img
                    src={resolveImageUrl(COINS_ART)}
                    alt=""
                    className="h-7 w-7 object-contain"
                  />
                }
                pressed={d.rewardType === 'credit'}
                onClick={() => pickReward('credit')}
              />
              <Tile
                title="A specific card"
                hint="Straight to the vault"
                icon={<Star />}
                pressed={d.rewardType === 'card'}
                onClick={() => pickReward('card')}
              />
            </div>
          </>
        );
      case 'value':
        if (d.rewardType === 'tickets') {
          return (
            <>
              {heading('How many tickets?')}
              <Numbers
                value={d.tickets}
                quick={[5, 10, 20, 50]}
                placeholder="Other"
                onPick={(v) => set({ tickets: String(v) })}
                onType={(tickets) => setD({ ...d, tickets })}
                onDone={() => setStep(firstMissing(d))}
              />
            </>
          );
        }
        if (d.rewardType === 'credit') {
          return (
            <>
              {heading('How much credit?')}
              <Numbers
                value={d.rewardValue}
                quick={[5, 10, 30, 50, 100]}
                format={money}
                placeholder="Other RM"
                onPick={(v) =>
                  set({
                    rewardValue: String(v),
                    prize: { ...NO_PRIZE, value: v },
                  })
                }
                onType={(rewardValue) =>
                  setD({
                    ...d,
                    rewardValue,
                    prize: { ...NO_PRIZE, value: Number(rewardValue) || null },
                  })
                }
                onDone={() => setStep(firstMissing(d))}
              />
            </>
          );
        }
        if (d.rewardType === 'pack') {
          // A free rip rolls a card, so a ticket pack can't be one. A free rip
          // skips the stock check, so a pack off sale still works as a reward.
          const giveable = (list: typeof packs) =>
            list.filter((p) => p.prize_type !== 'tickets');
          const pick = (p: (typeof packs)[number]) =>
            set({
              rewardValue: p.slug,
              prize: { name: p.title, image: p.image, value: p.price },
            });
          return (
            <>
              {heading('Which pack do they get to rip?')}
              {packsNote}
              <ArtGrid
                items={giveable(onSale).map((p) =>
                  packItem(p, d.rewardValue === p.slug, () => pick(p)),
                )}
              />
              {giveable(notOnSale).length > 0 && (
                <>
                  <Text size="xsmall" weight="plus" className="mt-4 mb-2">
                    Not on sale right now
                  </Text>
                  <ArtGrid
                    items={giveable(notOnSale).map((p) =>
                      packItem(p, d.rewardValue === p.slug, () => pick(p)),
                    )}
                  />
                </>
              )}
            </>
          );
        }
        {
          const found = (cardsQuery.data ?? []).filter((c) =>
            `${c.name} ${c.handle}`
              .toLowerCase()
              .includes(cardQuery.trim().toLowerCase()),
          );
          const shown = found.slice(0, CARDS_SHOWN);
          const items: ArtItem[] = shown.map((c) => ({
            key: c.handle,
            label: c.name,
            sub: c.grade ? `${c.grader} ${c.grade}` : undefined,
            image: c.slab_image || c.image,
            pressed: d.rewardValue === c.handle,
            onClick: () =>
              set({
                rewardValue: c.handle,
                prize: {
                  name: c.name,
                  image: c.slab_image || c.image,
                  value: c.priceBreakdown?.displayPrice ?? null,
                  grade: c.grade ? `${c.grader} ${c.grade}` : null,
                },
              }),
          }));
          if (
            d.rewardValue &&
            d.prize.name &&
            !shown.some((c) => c.handle === d.rewardValue)
          ) {
            items.unshift({
              key: d.rewardValue,
              label: d.prize.name,
              image: d.prize.image,
              pressed: true,
              onClick: () => setStep(firstMissing(d)),
            });
          }
          return (
            <>
              {heading('Which card?')}
              <Input
                aria-label="Search cards"
                placeholder="Search cards"
                className="mb-2.5 max-w-xs"
                value={cardQuery}
                onChange={(e) => setCardQuery(e.target.value)}
              />
              <PickerNote
                what="cards"
                loading={cardsQuery.isLoading}
                failed={cardsQuery.isError}
                empty={Boolean(cardsQuery.data) && found.length === 0}
                onRetry={() => cardsQuery.refetch()}
              />
              <ArtGrid items={items} />
              {found.length > CARDS_SHOWN && (
                <Text size="xsmall" className="text-ui-fg-muted mt-2">
                  Showing {CARDS_SHOWN} of {found.length}. Search to narrow it
                  down.
                </Text>
              )}
            </>
          );
        }
      default:
        return (
          <>
            <Text size="small" weight="plus">
              That's everything
            </Text>
            <Text size="small" className="text-ui-fg-subtle mt-1 max-w-prose">
              Tap any part of the sentence to change it. The name and the
              player's card follow.
            </Text>
          </>
        );
    }
  };

  const checks = draftChecks(d, weekRows, claims);
  const finalName = missing.length === 0 ? taskName(draftParts(d)) : null;

  return (
    <FocusModal open onOpenChange={(o) => !o && void requestClose()}>
      <FocusModal.Content>
        <FocusModal.Header>
          <div className="flex items-center gap-x-2">
            <Button
              size="small"
              variant="secondary"
              disabled={save.isPending}
              onClick={() => void requestClose()}
            >
              Cancel
            </Button>
            <Button
              size="small"
              onClick={submit}
              isLoading={save.isPending}
              disabled={!ready || save.isPending}
            >
              {d.id
                ? 'Save changes'
                : d.kind === 'weekly' && inViewedWeek
                  ? `Add to ${weekText}`
                  : 'Create task'}
            </Button>
          </div>
        </FocusModal.Header>
        <FocusModal.Body className="pc-admin overflow-auto">
          <div className="mx-auto grid max-w-[1200px] items-start lg:grid-cols-[minmax(0,1fr)_400px]">
            <div className="border-ui-border-base min-w-0 px-5 py-7 lg:border-r lg:px-10">
              <FocusModal.Title asChild>
                <Text
                  size="base"
                  weight="plus"
                  className="text-ui-fg-subtle mb-4"
                >
                  {d.id ? 'Edit task' : 'New task'}
                </Text>
              </FocusModal.Title>
              <FocusModal.Description className="sr-only">
                Build the task as a sentence. Its name and the player's card
                follow the sentence.
              </FocusModal.Description>
              <p className="text-[21px] leading-[2.1] tracking-tight">
                {chip('repeat', KIND_LABEL[d.kind], true)}, when a player{' '}
                {goalChips()}, they get {rewardChips()}.
              </p>

              <div
                ref={pickerRef}
                tabIndex={-1}
                aria-live="polite"
                className="mt-6 outline-none"
              >
                {picker()}
              </div>

              <details className="border-ui-border-base mt-7 border-t pt-3">
                <summary className="text-ui-fg-subtle cursor-pointer text-sm font-medium">
                  {runsText}. More options
                </summary>
                <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
                  <Field
                    label="Starts, in this computer's time"
                    htmlFor="task-starts"
                  >
                    <Input
                      id="task-starts"
                      type="datetime-local"
                      value={d.startsAt}
                      onChange={(e) => {
                        const { value, validity } = e.target;
                        setBadDate((b) => ({
                          ...b,
                          starts: validity.badInput,
                        }));
                        setD((cur) => ({ ...cur, startsAt: value }));
                      }}
                    />
                  </Field>
                  <Field
                    label="Ends, in this computer's time"
                    htmlFor="task-ends"
                  >
                    <Input
                      id="task-ends"
                      type="datetime-local"
                      value={d.endsAt}
                      onChange={(e) => {
                        const { value, validity } = e.target;
                        setBadDate((b) => ({ ...b, ends: validity.badInput }));
                        setD((cur) => ({ ...cur, endsAt: value }));
                      }}
                    />
                  </Field>
                  {d.rewardType !== 'tickets' && (
                    <Field label="Tickets on top" htmlFor="task-tickets">
                      <Input
                        id="task-tickets"
                        type="number"
                        min={0}
                        max={10000}
                        value={d.tickets}
                        onChange={(e) =>
                          setD({ ...d, tickets: e.target.value })
                        }
                      />
                    </Field>
                  )}
                  <Field label="Order" htmlFor="task-sort">
                    <Input
                      id="task-sort"
                      type="number"
                      step={1}
                      value={d.sort}
                      onChange={(e) => setD({ ...d, sort: e.target.value })}
                    />
                  </Field>
                  <Field
                    label="Listed on /task"
                    hint={
                      d.active
                        ? 'Players can see it.'
                        : 'Hidden. Anyone who already finished it can still claim.'
                    }
                  >
                    <div className="flex h-8 items-center">
                      <Switch
                        checked={d.active}
                        onCheckedChange={(active) => setD({ ...d, active })}
                        aria-label="Listed on /task"
                      />
                    </div>
                  </Field>
                </div>
                {d.endsAt !== '' && (
                  // The window gates CLAIMING, not just listing.
                  <Text size="small" className="text-ui-fg-subtle mt-2">
                    After the end time this task disappears and can no longer be
                    claimed, even by players who finished it but hadn't pressed
                    Claim.
                  </Text>
                )}
                {!scheduleValid && (
                  <Text size="small" className="text-ui-fg-error mt-2">
                    Finish typing both dates, with the end after the start.
                  </Text>
                )}
              </details>

              <div className="mt-5 max-w-md">
                <Field
                  label="Reason, recorded against your admin account"
                  htmlFor="task-reason"
                >
                  <Input
                    id="task-reason"
                    value={reason}
                    onChange={(e) => {
                      setReason(e.target.value);
                      setReasonEdited(true);
                    }}
                    placeholder="Why this change?"
                  />
                </Field>
              </div>
            </div>

            <aside className="flex flex-col gap-y-3.5 px-5 py-7 lg:sticky lg:top-0">
              <Text size="small" weight="plus">
                What players see on /task
              </Text>
              <PlayerPreview draft={d} />
              <div className="flex flex-col gap-y-2">
                {missing.length > 0 && (
                  <div className="flex gap-x-2">
                    <InformationCircle className="text-ui-fg-muted mt-0.5 shrink-0" />
                    <Text size="small" className="text-ui-fg-subtle">
                      Still needed: {missing.map((m) => m.label).join(', ')}.
                    </Text>
                  </div>
                )}
                {blockers.map((text) => (
                  <div key={String(text)} className="flex gap-x-2">
                    <InformationCircle className="text-ui-fg-muted mt-0.5 shrink-0" />
                    <Text size="small" className="text-ui-fg-subtle">
                      {text}
                    </Text>
                  </div>
                ))}
                {d.id && finalName && finalName !== d.title && (
                  <div className="flex gap-x-2">
                    <InformationCircle className="text-ui-fg-muted mt-0.5 shrink-0" />
                    <Text size="small" className="text-ui-fg-subtle">
                      Saving renames it from “{d.title}” to “{finalName}”.
                    </Text>
                  </div>
                )}
                {checks.map((c) => (
                  <div key={c.text} className="flex gap-x-2">
                    {c.tone === 'ok' ? (
                      <CheckCircleSolid className="text-ui-tag-green-icon mt-0.5 shrink-0" />
                    ) : c.tone === 'warn' ? (
                      <ExclamationCircle className="text-ui-tag-orange-icon mt-0.5 shrink-0" />
                    ) : (
                      <InformationCircle className="text-ui-fg-muted mt-0.5 shrink-0" />
                    )}
                    <Text
                      size="small"
                      className={
                        c.tone === 'warn'
                          ? 'text-ui-fg-base'
                          : 'text-ui-fg-subtle'
                      }
                    >
                      {c.text}
                    </Text>
                  </div>
                ))}
                {needsAnyConfirm(d) && missing.length === 0 && (
                  <div className="flex items-start gap-x-2">
                    <Checkbox
                      id="task-any-ok"
                      className="mt-0.5"
                      checked={anyOk}
                      onCheckedChange={(v) => setAnyOk(v === true)}
                    />
                    <Label htmlFor="task-any-ok" size="small" weight="plus">
                      Yes, any pack on purpose. Every paid rip counts.
                    </Label>
                  </div>
                )}
              </div>
            </aside>
          </div>
        </FocusModal.Body>
      </FocusModal.Content>
    </FocusModal>
  );
};
