import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  FocusModal,
  Heading,
  Input,
  Label,
  Select,
  Table,
  Text,
  toast,
} from '@medusajs/ui';
import {
  useCreatePlayers,
  useCustomerGroupsAdmin,
  useExportPartnerAccounts,
  type CreatedPlayer,
} from '../../lib/queries';
import {
  credentialLines,
  defaultGroupForNewPlayer,
  MAX_BATCH,
  parseBatchCount,
} from '../../lib/create-player';
import { effectiveOddsSet, isPartnerGroup } from '../../lib/player-groups';

// Partner account generator (POST /admin/players). The operator types
// nothing that has to be right: how many, an optional display name, and the
// group (preselected to the partner group). Emails and passwords are minted
// server-side and come back once here — and stay exportable from the Players
// page's "Export partner logins", so closing this without copying loses
// nothing.
type Props = {
  open: boolean;
  onClose: () => void;
};

const CreatePlayerModal = ({ open, onClose }: Props) => {
  const { t } = useTranslation();
  const { data: groupList, isError: groupsError } = useCustomerGroupsAdmin();
  const generate = useCreatePlayers();
  const exporter = useExportPartnerAccounts();

  const [count, setCount] = useState('1');
  const [name, setName] = useState('');
  // Unsaved pick only — undefined falls through to the computed default, so
  // the Select lands on the partner group the moment the list resolves.
  const [picked, setPicked] = useState<string | undefined>();
  const [created, setCreated] = useState<CreatedPlayer[] | null>(null);

  const fresh = () => {
    setCount('1');
    setName('');
    setPicked(undefined);
    setCreated(null);
  };

  // Reset on the open transition, during render (RegisterCardModal's pattern).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) fresh();
  }

  const groups = groupList?.customer_groups ?? [];
  const groupId = picked ?? defaultGroupForNewPlayer(groups);
  const batch = parseBatchCount(count);
  const canSave = batch !== null && !generate.isPending;

  const save = async () => {
    if (batch === null) return;
    try {
      const res = await generate.mutateAsync({
        count: batch,
        display_name: name.trim() || null,
        group_id: groupId || null,
      });
      setCreated(res.players);
    } catch {
      // useCreatePlayers' onError already toasted; the form stays as typed so
      // the operator can fix the name and retry.
    }
  };

  const copyAll = async () => {
    if (!created) return;
    await navigator.clipboard.writeText(credentialLines(created));
    toast.success(t('players.copied', { count: created.length }));
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
                  isLoading={generate.isPending}
                  disabled={!canSave}
                >
                  {t('players.createSave')}
                </Button>
              </>
            )}
          </div>
        </FocusModal.Header>
        <FocusModal.Body className="flex flex-col items-center overflow-auto p-10">
          <div className="flex w-full max-w-[760px] flex-col gap-y-6">
            {created ? (
              <>
                <div>
                  <FocusModal.Title asChild>
                    <Heading level="h2">
                      {t('players.createdTitle', { count: created.length })}
                    </Heading>
                  </FocusModal.Title>
                  <FocusModal.Description asChild>
                    <Text className="text-ui-fg-subtle mt-1" size="small">
                      {t('players.createdDesc')}
                    </Text>
                  </FocusModal.Description>
                </div>
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <Table.Header>
                      <Table.Row>
                        <Table.HeaderCell>
                          {t('players.createdName')}
                        </Table.HeaderCell>
                        <Table.HeaderCell>
                          {t('players.createdEmail')}
                        </Table.HeaderCell>
                        <Table.HeaderCell>
                          {t('players.createdPassword')}
                        </Table.HeaderCell>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {created.map((p) => (
                        <Table.Row key={p.id}>
                          <Table.Cell>{p.name ?? '—'}</Table.Cell>
                          <Table.Cell className="font-mono text-sm">
                            {p.email}
                          </Table.Cell>
                          <Table.Cell className="font-mono text-sm">
                            {p.password}
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table>
                </div>
                <div className="flex flex-wrap gap-x-2 gap-y-2">
                  <Button
                    size="small"
                    isLoading={exporter.isPending}
                    onClick={() => exporter.mutate(created.map((p) => p.id))}
                  >
                    {t('players.downloadXlsx')}
                  </Button>
                  <Button size="small" variant="secondary" onClick={copyAll}>
                    {t('players.copyAll')}
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
                    htmlFor="create-player-count"
                  >
                    {t('players.createCount')}
                  </Label>
                  <Input
                    id="create-player-count"
                    type="number"
                    min={1}
                    max={MAX_BATCH}
                    step={1}
                    className="w-32"
                    value={count}
                    onChange={(e) => setCount(e.target.value)}
                  />
                  <Text size="xsmall" className="text-ui-fg-subtle">
                    {t('players.createCountHint', { max: MAX_BATCH })}
                  </Text>
                </div>

                <div className="flex flex-col gap-y-2">
                  <Label
                    size="small"
                    weight="plus"
                    htmlFor="create-player-name"
                  >
                    {t('players.createName')}
                  </Label>
                  <Input
                    id="create-player-name"
                    autoComplete="off"
                    maxLength={30}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                  <Text size="xsmall" className="text-ui-fg-subtle">
                    {t('players.createNameHint')}
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
