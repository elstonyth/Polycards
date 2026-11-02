// New and edit, as one sentence: "Every week, when a player pulls 2 × Mew, they
// get 20 tickets." Each part is a button that opens its own small picker, and the
// name, the player's card and the checks all follow the sentence. Nothing starts
// filled in, so a part left alone can't quietly become the rule.
import { useState } from 'react';
import {
  Button,
  Checkbox,
  FocusModal,
  Input,
  Label,
  Select,
  Text,
  clx,
  toast,
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
import { taskName } from './task-board';
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

const money = (n: number): string =>
  `RM ${n.toLocaleString('en-MY', { maximumFractionDigits: 2 })}`;

const firstMissing = (d: Draft): Step => draftMissing(d)[0]?.step ?? 'done';

const GOALS: Record<
  string,
  { title: string; hint: string; icon: React.ReactNode }
> = {
  vault_pixel_count: {
    title: 'Pull a Pokémon',
    hint: 'Paid pulls, graded or not',
    icon: <Star />,
  },
  rip_count: {
    title: 'Rip packs',
    hint: 'Paid rips of a pack you pick',
    icon: <Sparkles />,
  },
  checkin_days: {
    title: 'Check in',
    hint: 'Days checked in this week',
    icon: <Calendar />,
  },
  topup_myr: {
    title: 'Top up',
    hint: 'Real top-ups only',
    icon: <CreditCard />,
  },
  reach_level: {
    title: 'Reach a VIP level',
    hint: 'Their highest level ever',
    icon: <Trophy />,
  },
  vault_count: {
    title: 'Vault cards',
    hint: 'Cards ever vaulted',
    icon: <Star />,
  },
};

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
    aria-pressed={current}
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

const ArtGrid = ({
  items,
  pixel,
}: {
  items: {
    key: string;
    label: string;
    sub?: string;
    image: string | null;
    pressed: boolean;
    onClick: () => void;
  }[];
  pixel?: boolean;
}) => (
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
  onClick,
}: {
  title: string;
  hint: string;
  pressed: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={pressed}
    className={clx(
      'hover:bg-ui-bg-base-hover mt-2 flex w-full items-center gap-x-3 rounded-lg border border-dashed px-3 py-2.5 text-left transition-colors',
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

const Numbers = ({
  value,
  quick,
  format = String,
  placeholder,
  onPick,
  onType,
}: {
  value: string;
  quick: number[];
  format?: (n: number) => string;
  placeholder: string;
  onPick: (n: number) => void;
  onType: (v: string) => void;
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
      value={quick.map(String).includes(value) ? '' : value}
      onChange={(e) => onType(e.target.value)}
    />
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
  /** What the week being viewed already holds, for the clash checks. */
  weekRows: AdminTaskDefinition[];
  weekText: string;
  /** The week being viewed, as form values. A weekly task runs there. */
  weekWindow: { startsAt: string; endsAt: string };
  onClose: () => void;
}) => {
  const save = useSaveTaskDefinition();
  const [d, setD] = useState(initial);
  const [step, setStep] = useState<Step>(firstMissing(initial));
  const [reason, setReason] = useState(
    initial.id ? '' : `Week of ${weekText} tasks`,
  );
  const [anyOk, setAnyOk] = useState(false);
  const [pixelQuery, setPixelQuery] = useState('');
  const [cardQuery, setCardQuery] = useState('');

  const locked = Boolean(d.id);
  const needsPacks =
    (d.reqType === 'rip_count' && step === 'target') ||
    (d.rewardType === 'pack' && step === 'value');
  const { data: packs } = usePacks({ enabled: needsPacks });
  const { data: cards } = useCards({
    enabled: d.rewardType === 'card' && step === 'value',
  });
  const { data: vip } = useVipLevels();
  const { data: pixel } = usePixelPokemon(
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
    const allowed = REQUIREMENT_TYPES[kind].includes(d.reqType);
    set({
      kind,
      startsAt: kind === 'weekly' ? weekWindow.startsAt : '',
      endsAt: kind === 'weekly' ? weekWindow.endsAt : '',
      ...(allowed
        ? {}
        : { reqType: '', reqN: '', reqPack: '', reqPixel: '', goal: NO_GOAL }),
    });
  };
  const pickReward = (rewardType: Draft['rewardType']) => {
    if (rewardType === d.rewardType) return setStep(firstMissing(d));
    set({
      rewardType,
      rewardValue: '',
      tickets: '0',
      prize: NO_PRIZE,
    });
  };

  const activePacks = (packs ?? [])
    .filter((p) => p.status === 'active' && p.price > 0)
    .sort((a, b) => a.price - b.price);

  const input = draftToInput(d, reason.trim());
  const missing = draftMissing(d);
  const anyWaiting = needsAnyConfirm(d) && !anyOk;
  const scheduleValid = scheduleOk(d);
  const ready =
    Boolean(input) &&
    missing.length === 0 &&
    !anyWaiting &&
    scheduleValid &&
    reason.trim() !== '';

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

  const whenLabel = KIND_LABEL[d.kind];
  const n = Number(d.reqN);
  const hasPrize =
    d.rewardType === 'tickets'
      ? Number(d.tickets) >= 1
      : d.rewardValue.trim() !== '' && d.rewardValue !== '0';

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
        const what =
          scope === ''
            ? pull
              ? 'which Pokémon?'
              : 'which pack?'
            : scope === ANY
              ? pull
                ? 'any Pokémon'
                : 'any pack'
              : (d.goal.name ?? scope);
        return (
          <>
            {chip('goal', pull ? 'pulls' : 'rips', true)}{' '}
            {chip('n', n > 0 ? String(n) : 'how many?', n > 0)} ×{' '}
            {chip('target', what, scope !== '', !pull && scope === ANY)}
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
            {chip(
              'value',
              hasPrize ? (d.prize.name ?? d.rewardValue) : 'which pack?',
              hasPrize,
            )}
          </>
        );
      case 'card':
        return (
          <>
            {chip('reward', 'the card', true)}{' '}
            {chip(
              'value',
              hasPrize ? (d.prize.name ?? d.rewardValue) : 'which card?',
              hasPrize,
            )}
          </>
        );
      default:
        return chip('reward', 'what?', false);
    }
  };

  const picker = () => {
    switch (step) {
      case 'repeat':
        return (
          <>
            <Text size="small" weight="plus" className="mb-2.5">
              How often can a player earn it?
            </Text>
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
            <Text size="small" weight="plus" className="mb-2.5">
              What does the player have to do?
            </Text>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-2">
              {REQUIREMENT_TYPES[d.kind].map((type) => (
                <Tile
                  key={type}
                  title={GOALS[type].title}
                  hint={GOALS[type].hint}
                  icon={GOALS[type].icon}
                  pressed={d.reqType === type}
                  onClick={() => pickGoal(type)}
                />
              ))}
            </div>
          </>
        );
      case 'n':
        if (d.reqType === 'checkin_days') {
          return (
            <>
              <Text size="small" weight="plus" className="mb-2.5">
                Which day of the check-in week?
              </Text>
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
              <Select value={d.reqN} onValueChange={(reqN) => set({ reqN })}>
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
            </Field>
          );
        }
        if (d.reqType === 'topup_myr') {
          return (
            <>
              <Text size="small" weight="plus" className="mb-2.5">
                How much do they top up?
              </Text>
              <Numbers
                value={d.reqN}
                quick={[100, 300, 500, 1000]}
                format={money}
                placeholder="Other RM"
                onPick={(v) => set({ reqN: String(v) })}
                onType={(reqN) => setD({ ...d, reqN })}
              />
            </>
          );
        }
        return (
          <>
            <Text size="small" weight="plus" className="mb-2.5">
              How many?
            </Text>
            <Numbers
              value={d.reqN}
              quick={[1, 2, 5, 10, 50]}
              placeholder="Other"
              onPick={(v) => set({ reqN: String(v) })}
              onType={(reqN) => setD({ ...d, reqN })}
            />
          </>
        );
      case 'target':
        if (d.reqType === 'vault_pixel_count') {
          return (
            <>
              <Text size="small" weight="plus" className="mb-2.5">
                Which Pokémon?
              </Text>
              <Input
                aria-label="Search Pokémon"
                placeholder="Search Pokémon"
                className="mb-2.5 max-w-xs"
                value={pixelQuery}
                onChange={(e) => setPixelQuery(e.target.value)}
              />
              <ArtGrid
                pixel
                items={(pixel?.pixel_pokemon ?? []).slice(0, 40).map((p) => ({
                  key: p.id,
                  label: p.name,
                  sub: p.dex ? `#${p.dex}` : undefined,
                  image: p.image_url,
                  pressed: d.reqPixel === p.id,
                  onClick: () =>
                    set({
                      reqPixel: p.id,
                      goal: { name: p.name, image: p.image_url, price: null },
                    }),
                }))}
              />
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
            <Text size="small" weight="plus" className="mb-2.5">
              Which pack?
            </Text>
            <ArtGrid
              items={activePacks.map((p) => ({
                key: p.slug,
                label: p.title,
                sub: money(p.price),
                image: p.image,
                pressed: d.reqPack === p.slug,
                onClick: () => {
                  setAnyOk(false);
                  set({
                    reqPack: p.slug,
                    goal: { name: p.title, image: p.image, price: p.price },
                  });
                },
              }))}
            />
            <AnyRow
              title="Any pack"
              hint={`Every paid rip counts${activePacks[0] ? `, even a ${money(activePacks[0].price)} ${activePacks[0].title}` : ''}. Pick this only on purpose.`}
              pressed={d.reqPack === ANY}
              onClick={() =>
                set({
                  reqPack: ANY,
                  goal: {
                    name: null,
                    image: null,
                    price: activePacks[0]?.price ?? null,
                  },
                })
              }
            />
          </>
        );
      case 'reward':
        return (
          <>
            <Text size="small" weight="plus" className="mb-2.5">
              What do they get?
            </Text>
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
              <Text size="small" weight="plus" className="mb-2.5">
                How many tickets?
              </Text>
              <Numbers
                value={d.tickets}
                quick={[5, 10, 20, 50]}
                placeholder="Other"
                onPick={(v) => set({ tickets: String(v) })}
                onType={(tickets) => setD({ ...d, tickets })}
              />
            </>
          );
        }
        if (d.rewardType === 'credit') {
          return (
            <>
              <Text size="small" weight="plus" className="mb-2.5">
                How much credit?
              </Text>
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
              />
            </>
          );
        }
        if (d.rewardType === 'pack') {
          return (
            <>
              <Text size="small" weight="plus" className="mb-2.5">
                Which pack do they get to rip?
              </Text>
              <ArtGrid
                items={activePacks
                  // A free rip rolls a card, so a ticket pack can't be one.
                  .filter((p) => p.prize_type !== 'tickets')
                  .map((p) => ({
                    key: p.slug,
                    label: p.title,
                    sub: money(p.price),
                    image: p.image,
                    pressed: d.rewardValue === p.slug,
                    onClick: () =>
                      set({
                        rewardValue: p.slug,
                        prize: {
                          name: p.title,
                          image: p.image,
                          value: p.price,
                        },
                      }),
                  }))}
              />
            </>
          );
        }
        return (
          <>
            <Text size="small" weight="plus" className="mb-2.5">
              Which card?
            </Text>
            <Input
              aria-label="Search cards"
              placeholder="Search cards"
              className="mb-2.5 max-w-xs"
              value={cardQuery}
              onChange={(e) => setCardQuery(e.target.value)}
            />
            <ArtGrid
              items={(cards ?? [])
                .filter((c) =>
                  `${c.name} ${c.handle}`
                    .toLowerCase()
                    .includes(cardQuery.trim().toLowerCase()),
                )
                .slice(0, 24)
                .map((c) => ({
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
                        value: null,
                      },
                    }),
                }))}
            />
          </>
        );
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
    <FocusModal open onOpenChange={(o) => !o && onClose()}>
      <FocusModal.Content>
        <FocusModal.Header>
          <div className="flex items-center gap-x-2">
            <Button size="small" variant="secondary" onClick={onClose}>
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
                : d.kind === 'weekly'
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
                {chip('repeat', whenLabel, true)}, when a player {goalChips()},
                they get {rewardChips()}.
              </p>

              <div className="mt-6">{picker()}</div>

              <details className="border-ui-border-base mt-7 border-t pt-3">
                <summary className="text-ui-fg-subtle cursor-pointer text-sm font-medium">
                  {d.kind === 'weekly' && d.startsAt && d.endsAt
                    ? `Runs ${weekText}. More options`
                    : 'More options'}
                </summary>
                <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
                  <Field label="Starts" htmlFor="task-starts">
                    <Input
                      id="task-starts"
                      type="datetime-local"
                      value={d.startsAt}
                      onChange={(e) => setD({ ...d, startsAt: e.target.value })}
                    />
                  </Field>
                  <Field label="Ends" htmlFor="task-ends">
                    <Input
                      id="task-ends"
                      type="datetime-local"
                      value={d.endsAt}
                      onChange={(e) => setD({ ...d, endsAt: e.target.value })}
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
                      value={d.sort}
                      onChange={(e) => setD({ ...d, sort: e.target.value })}
                    />
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
                    The end must be after the start.
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
                    onChange={(e) => setReason(e.target.value)}
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
