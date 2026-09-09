import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Container,
  Heading,
  Input,
  Label,
  Select,
  Switch,
  Table,
  Text,
} from '@medusajs/ui';
import { Users } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import {
  useCreateCustomerGroup,
  useCustomerGroupsAdmin,
  useGroupPlayerCount,
  useReferralSettings,
  useSetGroupOddsSet,
  useSetGroupPolicy,
  type AdminCustomerGroup,
} from '../../lib/queries';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import {
  DEFAULT_PLAYER_GROUP_NAME,
  effectiveOddsSet,
  groupPolicyOf,
  isDefaultPlayerGroup,
  oddsSetOf as coerce,
} from '../../lib/player-groups';

export const config: RouteConfig = {
  label: 'Player Groups',
  icon: Users,
  nested: '/customers',
  rank: 3,
};

type OddsSet = 1 | 2 | 3;
const SETS: OddsSet[] = [1, 2, 3];

/** Member count, per row. Its own query — see useGroupPlayerCount for why the
 *  count can't ride along on the group list request. */
const PlayerCount = ({ groupId }: { groupId: string }) => {
  const { data, isError } = useGroupPlayerCount(groupId);
  if (isError) return <span className="text-ui-fg-muted">—</span>;
  if (data === undefined) return <span className="text-ui-fg-muted">…</span>;
  return <span className="tabular-nums">{data}</span>;
};

/** The partner-policy half of a row, as the operator edits it. `ratePct` is a
 *  string so a half-typed "3." survives a render. */
type PolicyDraft = {
  partner: boolean;
  ratePct: string;
  withdrawalsBlocked: boolean;
  verificationExempt: boolean;
};

const draftOf = (group: AdminCustomerGroup): PolicyDraft => {
  const p = groupPolicyOf(group);
  return {
    partner: p.partner_rate_bp !== null,
    ratePct: p.partner_rate_bp === null ? '' : String(p.partner_rate_bp / 100),
    withdrawalsBlocked: p.withdrawals_blocked,
    verificationExempt: p.verification_exempt,
  };
};

const sameDraft = (a: PolicyDraft, b: PolicyDraft): boolean =>
  a.partner === b.partner &&
  a.ratePct.trim() === b.ratePct.trim() &&
  a.withdrawalsBlocked === b.withdrawalsBlocked &&
  a.verificationExempt === b.verificationExempt;

/** One group row: its odds set and its partner policy (both locked for the
 *  default group) and its member count. */
const GroupRow = ({ group }: { group: AdminCustomerGroup }) => {
  const { t } = useTranslation();
  const saveOdds = useSetGroupOddsSet();
  const savePolicy = useSetGroupPolicy();
  const { data: settings } = useReferralSettings();
  // Unsaved edits ONLY. Seeding from the server value would go stale after
  // the post-save invalidation refetch; `undefined` falls back to it every
  // render.
  const [picked, setPicked] = useState<OddsSet | undefined>();
  const [draft, setDraft] = useState<PolicyDraft | undefined>();

  // The default group's odds set AND policy are LOCKED, not merely hidden: its
  // members and customers with no group at all must behave identically, and
  // both the draw path and the policy resolver pin that row regardless of
  // what it stores. An editable control here would let the operator raise
  // "DEFAULT" to a partner group and believe they had moved the whole
  // ungrouped population onto it — they would not have, and nothing on
  // screen would say so.
  const locked = isDefaultPlayerGroup(group);
  const savedSet = effectiveOddsSet(group);
  const value = locked ? savedSet : (picked ?? savedSet);
  const oddsDirty = !locked && value !== savedSet;

  const saved = draftOf(group);
  const policy = locked ? saved : (draft ?? saved);
  const policyDirty = !locked && !sameDraft(policy, saved);
  const edit = (patch: Partial<PolicyDraft>) =>
    setDraft({ ...policy, ...patch });

  const boundsHint = settings
    ? `${settings.partner_min_bp / 100}–${settings.partner_max_bp / 100}%`
    : '';
  const rateBp = policy.partner
    ? Math.round(Number(policy.ratePct) * 100)
    : null;
  const rateInvalid =
    policy.partner &&
    (policy.ratePct.trim() === '' || !Number.isFinite(rateBp));

  const saving = saveOdds.isPending || savePolicy.isPending;

  const save = () => {
    // Reason FIRST: the policy write is audited and the prompt is its only
    // input, so a cancelled prompt must abort the whole save — firing the odds
    // write before asking would leave the row half-saved with Save still lit.
    const reason = policyDirty
      ? window.prompt(t('oddsSets.reasonPrompt'))?.trim()
      : undefined;
    if (policyDirty && !reason) return;
    // SEQUENCED, never concurrent: both writes land on the same metadata
    // column through Medusa's read-merge-write, so two in flight can overwrite
    // each other's keys with the stale copy each one read. Odds first (the
    // native route), policy after it settles.
    const writePolicy = () => {
      if (!policyDirty || !reason) return;
      savePolicy.mutate(
        {
          id: group.id,
          policy: {
            partner_rate_bp: rateBp,
            withdrawals_blocked: policy.partner && policy.withdrawalsBlocked,
            verification_exempt: policy.partner && policy.verificationExempt,
          },
          reason,
        },
        { onSuccess: () => setDraft(undefined) },
      );
    };
    if (oddsDirty) {
      saveOdds.mutate(
        { id: group.id, set: value },
        // Drop the override so the row re-reads the (now authoritative)
        // refetched server value, then write the policy on top of it.
        {
          onSuccess: () => {
            setPicked(undefined);
            writePolicy();
          },
        },
      );
    } else {
      writePolicy();
    }
  };

  return (
    <Table.Row>
      <Table.Cell>{group.name}</Table.Cell>
      <Table.Cell>
        <Select
          value={String(value)}
          disabled={locked}
          onValueChange={(v) => setPicked(coerce(Number(v)))}
        >
          <Select.Trigger className="w-28">
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            {SETS.map((s) => (
              <Select.Item key={s} value={String(s)}>
                {t('oddsSets.setN', { n: s })}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>
      </Table.Cell>
      {/* Partner policy (spec 2026-09-09). The switch is the one control:
          off clears the rate and both toggles on save, so a group is never
          half-partner. */}
      <Table.Cell>
        <Switch
          checked={policy.partner}
          disabled={locked || saving}
          onCheckedChange={(on) => edit({ partner: on })}
          aria-label={`${t('oddsSets.partner')} — ${group.name}`}
        />
      </Table.Cell>
      <Table.Cell>
        {policy.partner ? (
          <div className="flex items-center gap-1">
            <Input
              type="number"
              className="w-20"
              value={policy.ratePct}
              placeholder={boundsHint}
              disabled={locked || saving}
              onChange={(e) => edit({ ratePct: e.target.value })}
              aria-label={`${t('oddsSets.partnerRate')} — ${group.name}`}
            />
            <Text size="small" className="text-ui-fg-muted">
              %
            </Text>
          </div>
        ) : (
          <span className="text-ui-fg-muted">—</span>
        )}
      </Table.Cell>
      <Table.Cell>
        {policy.partner ? (
          <Select
            value={policy.withdrawalsBlocked ? 'blocked' : 'allowed'}
            disabled={locked || saving}
            onValueChange={(v) => edit({ withdrawalsBlocked: v === 'blocked' })}
          >
            <Select.Trigger className="w-28">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="allowed">
                {t('oddsSets.withdrawalsAllowed')}
              </Select.Item>
              <Select.Item value="blocked">
                {t('oddsSets.withdrawalsBlocked')}
              </Select.Item>
            </Select.Content>
          </Select>
        ) : (
          <span className="text-ui-fg-muted">—</span>
        )}
      </Table.Cell>
      <Table.Cell>
        {policy.partner ? (
          <Select
            value={policy.verificationExempt ? 'off' : 'required'}
            disabled={locked || saving}
            onValueChange={(v) => edit({ verificationExempt: v === 'off' })}
          >
            <Select.Trigger className="w-28">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="required">
                {t('oddsSets.verificationRequired')}
              </Select.Item>
              <Select.Item value="off">
                {t('oddsSets.verificationOff')}
              </Select.Item>
            </Select.Content>
          </Select>
        ) : (
          <span className="text-ui-fg-muted">—</span>
        )}
      </Table.Cell>
      <Table.Cell className="text-right">
        <PlayerCount groupId={group.id} />
      </Table.Cell>
      <Table.Cell className="text-right">
        {locked ? (
          <Text size="small" className="text-ui-fg-muted">
            {t('oddsSets.defaultLocked')}
          </Text>
        ) : (
          <Button
            size="small"
            variant="secondary"
            disabled={(!oddsDirty && !policyDirty) || rateInvalid || saving}
            onClick={save}
          >
            {t('oddsSets.save')}
          </Button>
        )}
      </Table.Cell>
    </Table.Row>
  );
};

/**
 * Player groups ARE Medusa customer groups — the SAME rows the prebuilt
 * /customer-groups screen lists and populates, so there is no separate "player
 * groups" page. This one owns the things that screen has no field for: a
 * group's odds set, its partner policy (rate, withdrawals, phone
 * verification), and creating a group with its odds set already chosen. A
 * PLAYER's group is changed from their own profile (routes/customers/[id]).
 */
const OddsSetsPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data, isError } = useCustomerGroupsAdmin();
  const create = useCreateCustomerGroup();
  const [name, setName] = useState('');
  const [newSet, setNewSet] = useState<OddsSet>(1);

  const groups = data?.customer_groups ?? [];
  const trimmed = name.trim();
  // Case-insensitive: the name column is unique, so a differing-only-by-case
  // duplicate is a 4xx from the server — catch it before the round trip.
  // DEFAULT is also rejected on this branch even when no such group exists yet:
  // the backend adopts a group of that name as THE default group, so creating
  // one by hand would hand it set-1-forever semantics the operator never asked
  // for (and "default" in another case would collide the moment the real one is
  // created).
  const duplicate =
    trimmed.toLowerCase() === DEFAULT_PLAYER_GROUP_NAME.toLowerCase() ||
    groups.some((g) => g.name.toLowerCase() === trimmed.toLowerCase());

  const submit = () => {
    if (!trimmed || duplicate || create.isPending) return;
    create.mutate(
      { name: trimmed, set: newSet },
      {
        onSuccess: () => {
          setName('');
          setNewSet(1);
        },
      },
    );
  };

  return (
    <Container className="p-0">
      <div className="px-6 py-4">
        <Heading level="h2">{t('oddsSets.title')}</Heading>
        <Text className="text-ui-fg-subtle mt-1" size="small">
          {t('oddsSets.subtitle')}
        </Text>
      </div>

      {/* Create — name and odds set together, so a new group is never live on
          set 1 for the window between creating it and picking its set. */}
      <div className="flex flex-wrap items-end gap-3 border-t px-6 py-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="new-group-name" size="small">
            {t('oddsSets.nameLabel')}
          </Label>
          <Input
            id="new-group-name"
            className="w-64"
            maxLength={100}
            value={name}
            placeholder={t('oddsSets.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="new-group-set" size="small">
            {t('oddsSets.oddsSet')}
          </Label>
          <Select
            value={String(newSet)}
            onValueChange={(v) => setNewSet(coerce(Number(v)))}
          >
            <Select.Trigger id="new-group-set" className="w-28">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {SETS.map((s) => (
                <Select.Item key={s} value={String(s)}>
                  {t('oddsSets.setN', { n: s })}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
        </div>
        <Button
          onClick={submit}
          isLoading={create.isPending}
          disabled={!trimmed || duplicate}
        >
          {t('oddsSets.create')}
        </Button>
        {duplicate && (
          <Text size="small" className="text-ui-fg-error pb-2">
            {t('oddsSets.duplicate')}
          </Text>
        )}
      </div>

      {isError ? (
        <div className="border-t px-6 py-8">
          <Text className="text-ui-fg-subtle">{t('oddsSets.loadError')}</Text>
        </div>
      ) : !data ? (
        <div className="border-t px-6 py-8">
          <LoadingSkeleton />
        </div>
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-start gap-3 border-t px-6 py-8">
          <Text className="text-ui-fg-subtle">{t('oddsSets.empty')}</Text>
          <Button
            size="small"
            variant="secondary"
            onClick={() => navigate('/customer-groups')}
          >
            {t('oddsSets.goToGroups')}
          </Button>
        </div>
      ) : (
        <div
          className="overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-label={t('oddsSets.title')}
        >
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>{t('oddsSets.group')}</Table.HeaderCell>
                <Table.HeaderCell>{t('oddsSets.oddsSet')}</Table.HeaderCell>
                <Table.HeaderCell>{t('oddsSets.partner')}</Table.HeaderCell>
                <Table.HeaderCell>{t('oddsSets.partnerRate')}</Table.HeaderCell>
                <Table.HeaderCell>{t('oddsSets.withdrawals')}</Table.HeaderCell>
                <Table.HeaderCell>
                  {t('oddsSets.verification')}
                </Table.HeaderCell>
                <Table.HeaderCell className="text-right">
                  {t('oddsSets.players')}
                </Table.HeaderCell>
                <Table.HeaderCell className="text-right">
                  {t('oddsSets.actions')}
                </Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {groups.map((g) => (
                <GroupRow key={g.id} group={g} />
              ))}
            </Table.Body>
          </Table>
          <div className="border-t px-6 py-3">
            <Text size="xsmall" className="text-ui-fg-muted">
              {t('oddsSets.policyHint')}
            </Text>
          </div>
        </div>
      )}
    </Container>
  );
};

export default OddsSetsPage;
