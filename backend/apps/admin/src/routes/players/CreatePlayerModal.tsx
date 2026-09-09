import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Copy,
  FocusModal,
  Heading,
  Input,
  Label,
  Select,
  Text,
} from '@medusajs/ui';
import { useCreatePlayer, useCustomerGroupsAdmin } from '../../lib/queries';
import {
  defaultGroupForNewPlayer,
  generatePlayerEmail,
  generatePlayerPassword,
} from '../../lib/create-player';
import { effectiveOddsSet, isPartnerGroup } from '../../lib/player-groups';

// Mint a storefront login from the dashboard (POST /admin/players): a
// generated email + password the operator hands to a partner, and ONE player
// group, preselected to the partner group. Every value is editable before
// saving; the route validates what is submitted.
type Props = {
  open: boolean;
  onClose: () => void;
};

// What the operator hands over. Held AFTER the create so the modal can show
// it once: only the hash is stored, so closing this view without copying
// means a password reset.
type Created = { id: string; email: string; password: string; group: string };

const CreatePlayerModal = ({ open, onClose }: Props) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: groupList, isError: groupsError } = useCustomerGroupsAdmin();
  const create = useCreatePlayer();

  const [email, setEmail] = useState(generatePlayerEmail);
  const [password, setPassword] = useState(generatePlayerPassword);
  // Unsaved pick only — undefined falls through to the computed default, so
  // the Select lands on the partner group the moment the list resolves.
  const [picked, setPicked] = useState<string | undefined>();
  const [created, setCreated] = useState<Created | null>(null);

  const fresh = () => {
    setEmail(generatePlayerEmail());
    setPassword(generatePlayerPassword());
    setPicked(undefined);
    setCreated(null);
  };

  // Fresh credentials on every open, during render (RegisterCardModal's
  // pattern) — a reused email would be refused on the second create.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) fresh();
  }

  const groups = groupList?.customer_groups ?? [];
  const groupId = picked ?? defaultGroupForNewPlayer(groups);
  const canSave =
    email.trim() !== '' && password.length >= 8 && !create.isPending;

  const save = async () => {
    try {
      const res = await create.mutateAsync({
        email: email.trim(),
        password,
        group_id: groupId || null,
      });
      setCreated({
        id: res.player.id,
        email: res.player.email,
        password,
        group: res.player.group.name,
      });
    } catch {
      // useCreatePlayer's onError already toasted; the form stays as typed so
      // the operator can fix the email and retry.
    }
  };

  const openPlayer = (id: string) => {
    onClose();
    navigate(`/customers/${id}`);
  };

  return (
    <FocusModal
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <FocusModal.Content>
        <FocusModal.Header>
          <div className="flex items-center justify-end gap-x-2">
            {created ? (
              <Button size="small" onClick={onClose}>
                {t('players.done')}
              </Button>
            ) : (
              <>
                <Button size="small" variant="secondary" onClick={onClose}>
                  {t('players.cancel')}
                </Button>
                <Button
                  size="small"
                  onClick={save}
                  isLoading={create.isPending}
                  disabled={!canSave}
                >
                  {t('players.createSave')}
                </Button>
              </>
            )}
          </div>
        </FocusModal.Header>
        <FocusModal.Body className="flex flex-col items-center overflow-auto p-10">
          <div className="flex w-full max-w-[560px] flex-col gap-y-6">
            {created ? (
              <>
                <div>
                  <FocusModal.Title asChild>
                    <Heading level="h2">{t('players.createdTitle')}</Heading>
                  </FocusModal.Title>
                  <FocusModal.Description asChild>
                    <Text className="text-ui-fg-subtle mt-1" size="small">
                      {t('players.createdDesc')}
                    </Text>
                  </FocusModal.Description>
                </div>
                <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-3">
                  <dt>
                    <Text size="small" weight="plus">
                      {t('players.createEmail')}
                    </Text>
                  </dt>
                  <dd className="flex items-center gap-x-2 font-mono text-sm">
                    <span className="break-all">{created.email}</span>
                    <Copy content={created.email} />
                  </dd>
                  <dt>
                    <Text size="small" weight="plus">
                      {t('players.createPassword')}
                    </Text>
                  </dt>
                  <dd className="flex items-center gap-x-2 font-mono text-sm">
                    <span className="break-all">{created.password}</span>
                    <Copy content={created.password} />
                  </dd>
                  <dt>
                    <Text size="small" weight="plus">
                      {t('players.createGroup')}
                    </Text>
                  </dt>
                  <dd>
                    <Text size="small">{created.group}</Text>
                  </dd>
                </dl>
                <div className="flex flex-wrap gap-x-2 gap-y-2">
                  <Copy
                    content={`${created.email}\n${created.password}`}
                    asChild
                  >
                    <Button size="small">{t('players.copyBoth')}</Button>
                  </Copy>
                  <Button
                    size="small"
                    variant="secondary"
                    onClick={() => openPlayer(created.id)}
                  >
                    {t('players.createdOpen')}
                  </Button>
                  <Button size="small" variant="secondary" onClick={fresh}>
                    {t('players.createdAnother')}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div>
                  <FocusModal.Title asChild>
                    <Heading level="h2">{t('players.createTitle')}</Heading>
                  </FocusModal.Title>
                  <FocusModal.Description asChild>
                    <Text className="text-ui-fg-subtle mt-1" size="small">
                      {t('players.createSubtitle')}
                    </Text>
                  </FocusModal.Description>
                </div>

                <div className="flex flex-col gap-y-2">
                  <Label
                    size="small"
                    weight="plus"
                    htmlFor="create-player-email"
                  >
                    {t('players.createEmail')}
                  </Label>
                  <Input
                    id="create-player-email"
                    type="email"
                    autoComplete="off"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>

                <div className="flex flex-col gap-y-2">
                  <Label
                    size="small"
                    weight="plus"
                    htmlFor="create-player-password"
                  >
                    {t('players.createPassword')}
                  </Label>
                  <div className="flex gap-x-2">
                    {/* type="text", not "password": the operator has to read
                        it out to the partner, and nothing is hidden from them
                        anyway — they just generated it. */}
                    <Input
                      id="create-player-password"
                      type="text"
                      autoComplete="off"
                      className="font-mono"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    <Button
                      size="small"
                      variant="secondary"
                      type="button"
                      onClick={() => setPassword(generatePlayerPassword())}
                    >
                      {t('players.createRegenerate')}
                    </Button>
                  </div>
                  <Text size="xsmall" className="text-ui-fg-subtle">
                    {t('players.createPasswordHint')}
                  </Text>
                </div>

                <div className="flex flex-col gap-y-2">
                  <Label
                    size="small"
                    weight="plus"
                    htmlFor="create-player-group"
                  >
                    {t('players.createGroup')}
                  </Label>
                  {groupsError ? (
                    <Text size="small" className="text-ui-fg-error">
                      {t('players.groupLoadError')}
                    </Text>
                  ) : (
                    <Select value={groupId} onValueChange={setPicked}>
                      <Select.Trigger id="create-player-group">
                        <Select.Value placeholder={t('players.groupNone')} />
                      </Select.Trigger>
                      <Select.Content>
                        {groups.map((g) => (
                          <Select.Item key={g.id} value={g.id}>
                            {g.name} —{' '}
                            {t('players.groupOddsSet', {
                              n: effectiveOddsSet(g),
                            })}
                            {isPartnerGroup(g)
                              ? ` · ${t('players.partner')}`
                              : ''}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select>
                  )}
                  <Text size="xsmall" className="text-ui-fg-subtle">
                    {t('players.createGroupHint')}
                  </Text>
                </div>
              </>
            )}
          </div>
        </FocusModal.Body>
      </FocusModal.Content>
    </FocusModal>
  );
};

export default CreatePlayerModal;
