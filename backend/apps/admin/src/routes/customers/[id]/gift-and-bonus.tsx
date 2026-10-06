import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Container,
  Heading,
  Input,
  Label,
  Prompt,
  Select,
  StatusBadge,
  Table,
  Text,
  Textarea,
  toast,
} from '@medusajs/ui';
import {
  useAdjustCredits,
  useCustomerGacha,
  useCustomerPackGifts,
  useGrantPackGifts,
  usePacks,
  useRevokePackGift,
} from '../../../lib/queries';
import type { PackGift } from '../../../lib/admin-rest';
import { orderDateTime, rm } from '../../../lib/format';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';

// Gift packs + Bonus credit (spec 2026-10-07 §2). Both follow the page's own
// pattern: plain useState fields, one Prompt to confirm, the hook toasts errors
// with the backend's message. The backend is the authority on every rule below
// (mint cap, bonus floor, pack eligibility); the client checks only shape.

// Categories a gift may never target — the backend refuses them too.
const UNGIFTABLE = ['free_welcome', 'reward_box'];

const STATE_TONE: Record<PackGift['state'], 'blue' | 'green' | 'grey' | 'red'> =
  {
    unopened: 'blue',
    opened: 'green',
    revoked: 'grey',
    stuck: 'red',
  };

// Signed RM, at most 2dp — the backend's bonus amount shape.
const AMOUNT_RE = /^[+-]?\d+(\.\d{1,2})?$/;
const BONUS_MAX = 1_000_000;

type Confirm =
  | { kind: 'gift' }
  | { kind: 'bonus' }
  | { kind: 'revoke'; gift: PackGift };

export const GiftAndBonusPanels = ({ customerId }: { customerId: string }) => {
  const { t } = useTranslation();
  // Same key as the page header's — a cache read, not a second request.
  const { data: view } = useCustomerGacha(customerId);
  const giftsQ = useCustomerPackGifts(customerId);
  // The packs list fans out to every odds row (queries.ts usePacks), so it is
  // only fetched once the operator opens the pack select.
  const [packsWanted, setPacksWanted] = useState(false);
  const packsQ = usePacks({ enabled: packsWanted });
  const grant = useGrantPackGifts();
  const revoke = useRevokePackGift();
  const adjust = useAdjustCredits();

  const [packSlug, setPackSlug] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [giftNote, setGiftNote] = useState('');
  const [bonusAmount, setBonusAmount] = useState('');
  const [bonusNote, setBonusNote] = useState('');
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const email = view?.customer.email ?? customerId;

  // group === null = empty prize pool, i.e. a pack with no odds (spec §2).
  const packs = (packsQ.data ?? []).filter(
    (p) =>
      p.status === 'active' &&
      !UNGIFTABLE.includes(p.category) &&
      p.group !== null,
  );
  const packTitle =
    packs.find((p) => p.slug === packSlug)?.title ?? packSlug;

  const qty = Number(quantity);
  const giftValid =
    !!packSlug &&
    Number.isInteger(qty) &&
    qty >= 1 &&
    qty <= 10 &&
    !!giftNote.trim();

  const bonusNum = Number(bonusAmount.trim());
  const amountValid =
    AMOUNT_RE.test(bonusAmount.trim()) &&
    bonusNum !== 0 &&
    Math.abs(bonusNum) <= BONUS_MAX;
  const bonusValid = amountValid && !!bonusNote.trim();

  // Re-checks validity and pending state: the Prompt's Action is a second
  // submit path, and the fields can't change while it is open but a request
  // from an earlier confirm can still be in flight.
  function handleConfirm() {
    const c = confirm;
    setConfirm(null);
    if (!c) return;
    if (c.kind === 'gift') {
      if (!giftValid || grant.isPending) return;
      grant.mutate(
        {
          id: customerId,
          pack_id: packSlug,
          quantity: qty,
          note: giftNote.trim(),
          // Fresh per confirmed submit, minted here and not in mutationFn.
          idempotency_key: crypto.randomUUID(),
        },
        {
          onSuccess: () => {
            toast.success(
              t('customer360.gift.sent', { quantity: qty, pack: packTitle }),
            );
            setQuantity('1');
            setGiftNote('');
          },
        },
      );
    } else if (c.kind === 'bonus') {
      if (!bonusValid || adjust.isPending) return;
      adjust.mutate(
        {
          id: customerId,
          amount: bonusNum,
          note: bonusNote.trim(),
          idempotencyKey: crypto.randomUUID(),
          kind: 'bonus',
        },
        {
          onSuccess: () => {
            toast.success(t('customer360.bonus.applied'));
            setBonusAmount('');
            setBonusNote('');
          },
        },
      );
    } else {
      if (revoke.isPending) return;
      revoke.mutate(
        { giftId: c.gift.id, customerId },
        { onSuccess: () => toast.success(t('customer360.gift.revoked')) },
      );
    }
  }

  const promptTitle = !confirm
    ? ''
    : confirm.kind === 'gift'
      ? t('customer360.gift.confirmTitle', {
          quantity: qty,
          pack: packTitle,
          email,
        })
      : confirm.kind === 'bonus'
        ? t(
            bonusNum > 0
              ? 'customer360.bonus.confirmGive'
              : 'customer360.bonus.confirmTake',
            { amount: rm(Math.abs(bonusNum)), email },
          )
        : t('customer360.gift.revokeTitle', { pack: confirm.gift.pack_title });
  const promptDesc = !confirm
    ? ''
    : confirm.kind === 'gift'
      ? t('customer360.gift.confirmDesc')
      : confirm.kind === 'bonus'
        ? t('customer360.bonus.confirmDesc')
        : t('customer360.gift.revokeDesc');
  const promptAction = !confirm
    ? ''
    : confirm.kind === 'gift'
      ? t('customer360.gift.send')
      : confirm.kind === 'bonus'
        ? t('customer360.bonus.apply')
        : t('customer360.gift.revoke');

  const gifts = giftsQ.data;

  return (
    <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-3">
      {/* ── Gift packs ─────────────────────────────────────────── */}
      <Container className="p-0 lg:col-span-2">
        <div className="px-6 py-4">
          <Heading level="h2">{t('customer360.gift.title')}</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            {t('customer360.gift.subtitle')}
          </Text>
        </div>

        <div className="flex flex-wrap items-end gap-3 border-t px-6 py-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="gift-pack" size="small">
              {t('customer360.gift.pack')}
            </Label>
            <Select
              value={packSlug}
              onValueChange={setPackSlug}
              onOpenChange={(open) => {
                if (open) setPacksWanted(true);
              }}
            >
              {/* Hover/focus starts the fetch a beat before the click. */}
              <Select.Trigger
                id="gift-pack"
                className="w-64"
                onPointerEnter={() => setPacksWanted(true)}
                onFocus={() => setPacksWanted(true)}
              >
                <Select.Value
                  placeholder={t('customer360.gift.packPlaceholder')}
                />
              </Select.Trigger>
              <Select.Content>
                {/* Without these an empty list reads as "nothing giftable". */}
                {packsQ.isError ? (
                  <Text size="small" className="text-ui-fg-error px-2 py-1.5">
                    {t('customer360.gift.packsError')}
                  </Text>
                ) : (
                  !packsQ.data && (
                    <Text
                      size="small"
                      className="text-ui-fg-subtle px-2 py-1.5"
                    >
                      {t('customer360.gift.packsLoading')}
                    </Text>
                  )
                )}
                {packs.map((p) => (
                  <Select.Item key={p.slug} value={p.slug}>
                    {p.title} — {rm(p.price)}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="gift-qty" size="small">
              {t('customer360.gift.quantity')}
            </Label>
            <Input
              id="gift-qty"
              type="number"
              min={1}
              max={10}
              step={1}
              className="w-28"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
          <div className="flex min-w-[16rem] flex-1 flex-col gap-1">
            <Label htmlFor="gift-note" size="small">
              {t('customer360.gift.note')}
            </Label>
            <Textarea
              id="gift-note"
              rows={1}
              maxLength={512}
              value={giftNote}
              onChange={(e) => setGiftNote(e.target.value)}
            />
          </div>
          <Button
            size="small"
            onClick={() => setConfirm({ kind: 'gift' })}
            disabled={!giftValid}
            isLoading={grant.isPending}
          >
            {t('customer360.gift.send')}
          </Button>
        </div>

        {giftsQ.isError ? (
          <div className="border-t px-6 py-6">
            <Text size="small" className="text-ui-fg-error">
              {t('customer360.gift.loadError')}
            </Text>
          </div>
        ) : !gifts ? (
          <div className="border-t px-6 py-6">
            <LoadingSkeleton />
          </div>
        ) : gifts.length === 0 ? (
          <div className="border-t px-6 py-6">
            <Text className="text-ui-fg-subtle">
              {t('customer360.gift.empty')}
            </Text>
          </div>
        ) : (
          <div
            className="overflow-x-auto border-t"
            tabIndex={0}
            role="region"
            aria-label={t('customer360.gift.title')}
          >
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>
                    {t('customer360.gift.colPack')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    {t('customer360.gift.colState')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    {t('customer360.gift.colGranted')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    {t('customer360.gift.colNote')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    {t('customer360.gift.colOpened')}
                  </Table.HeaderCell>
                  <Table.HeaderCell />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {gifts.map((g) => (
                  <Table.Row key={g.id}>
                    <Table.Cell>{g.pack_title}</Table.Cell>
                    <Table.Cell>
                      {/* An unknown state from a newer backend lands on grey
                          with its raw name, not an empty badge. */}
                      <StatusBadge color={STATE_TONE[g.state] ?? 'grey'}>
                        {t(`customer360.gift.state.${g.state}`, g.state)}
                      </StatusBadge>
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle tabular-nums whitespace-nowrap">
                      {orderDateTime(g.created_at)}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle max-w-[20rem] truncate">
                      {g.note}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle tabular-nums whitespace-nowrap">
                      {g.opened_at ? orderDateTime(g.opened_at) : '—'}
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      {g.state === 'unopened' && (
                        <Button
                          size="small"
                          variant="secondary"
                          onClick={() => setConfirm({ kind: 'revoke', gift: g })}
                          disabled={revoke.isPending}
                          isLoading={
                            revoke.isPending &&
                            revoke.variables?.giftId === g.id
                          }
                        >
                          {t('customer360.gift.revoke')}
                        </Button>
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
      </Container>

      {/* ── Bonus credit ───────────────────────────────────────── */}
      <Container className="p-0">
        <div className="px-6 py-4">
          <Heading level="h2">{t('customer360.bonus.title')}</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            {t('customer360.bonus.subtitle')}
          </Text>
        </div>
        <div className="border-t px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle">
            {t('customer360.bonus.balance')}
          </Text>
          <Heading level="h1" className="mt-1 tabular-nums">
            {view ? rm(view.bonus_balance ?? 0) : '—'}
          </Heading>
        </div>
        <div className="flex flex-col gap-3 border-t px-6 py-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="bonus-amount" size="small">
              {t('customer360.bonus.amount')}
            </Label>
            <Input
              id="bonus-amount"
              inputMode="decimal"
              value={bonusAmount}
              onChange={(e) => setBonusAmount(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="bonus-note" size="small">
              {t('customer360.bonus.note')}
            </Label>
            <Textarea
              id="bonus-note"
              rows={2}
              maxLength={512}
              value={bonusNote}
              onChange={(e) => setBonusNote(e.target.value)}
            />
          </div>
          {bonusAmount.trim() !== '' && !amountValid && (
            <Text size="small" className="text-ui-fg-error">
              {t('customer360.bonus.invalid')}
            </Text>
          )}
          <Button
            size="small"
            className="self-end"
            onClick={() => setConfirm({ kind: 'bonus' })}
            disabled={!bonusValid}
            isLoading={adjust.isPending}
          >
            {t('customer360.bonus.apply')}
          </Button>
        </div>
      </Container>

      <Prompt
        variant={confirm?.kind === 'revoke' ? 'danger' : 'confirmation'}
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <Prompt.Content>
          <Prompt.Header>
            <Prompt.Title>{promptTitle}</Prompt.Title>
            <Prompt.Description>{promptDesc}</Prompt.Description>
          </Prompt.Header>
          <Prompt.Footer>
            <Prompt.Cancel>{t('support.adjustCancel')}</Prompt.Cancel>
            <Prompt.Action onClick={handleConfirm}>{promptAction}</Prompt.Action>
          </Prompt.Footer>
        </Prompt.Content>
      </Prompt>
    </div>
  );
};
