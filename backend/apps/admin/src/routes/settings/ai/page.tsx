import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Label,
  Select,
  Text,
  toast,
} from '@medusajs/ui';
import type { Permission, RouteConfig } from '@mercurjs/dashboard-sdk';
import {
  assistantApi,
  streamVoiceTest,
  type AssistantSettings,
} from '../../../lib/assistant';
import { PcmPlayer } from '../../../lib/voice';
import { AiOrb } from '../../../components/assistant/AiOrb';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';
import { ImageStyleCard } from './image-style';

// Settings → AI (spec 2026-10-29): the OpenRouter key the assistant uses for
// answers and images, which models, and the per-person daily spend limit.
// The key is write-only: the server never sends it back, only its last 4.
export const config: RouteConfig = {
  label: 'pcNav.aiSettings',
  translationNs: 'translation',
  rank: 90,
  permissions: ['assistant_setting:read' as Permission],
};

const KEY = ['assistant', 'settings'];

const AiSettingsPage = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: KEY, queryFn: assistantApi.settings });
  const s = settings.data?.settings;
  const [key, setKey] = useState('');
  const [chatModel, setChatModel] = useState('');
  const [imageModel, setImageModel] = useState('');
  const [cap, setCap] = useState('');
  const [sttModel, setSttModel] = useState('');
  const [voiceModel, setVoiceModel] = useState('');
  const [voiceName, setVoiceName] = useState('');
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<string | null>(null);

  // Filled once from the server: saving the key must not wipe unsaved edits.
  const seeded = useRef(false);
  useEffect(() => {
    if (!s || seeded.current) return;
    seeded.current = true;
    setChatModel(s.chat_model);
    setImageModel(s.image_model);
    setCap(String(s.daily_cap_usd));
    setSttModel(s.stt_model);
    setVoiceModel(s.voice_model);
    setVoiceName(s.voice);
  }, [s]);

  const save = async (
    patch: Parameters<typeof assistantApi.saveSettings>[0],
  ) => {
    setSaving(true);
    setTest(null);
    try {
      const res = await assistantApi.saveSettings(patch);
      qc.setQueryData<{ settings: AssistantSettings }>(KEY, res);
      void qc.invalidateQueries({ queryKey: ['assistant', 'me'] });
      toast.success(t('assistant.settings.saved'));
      return true;
    } catch (err) {
      toast.error((err as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTest(t('assistant.settings.testing'));
    try {
      const r = await assistantApi.testKey();
      setTest(
        r.ok
          ? t('assistant.settings.testOk', {
              used: r.account.usage.toFixed(2),
              left:
                r.account.limit_remaining === null
                  ? t('assistant.settings.noLimit')
                  : `USD ${r.account.limit_remaining.toFixed(2)}`,
            })
          : t('assistant.settings.testFail', { message: r.message }),
      );
    } catch (err) {
      setTest(
        t('assistant.settings.testFail', { message: (err as Error).message }),
      );
    }
  };

  // A cap from 0.5 to 1000; an empty field would otherwise save as 0.
  const capValue = Number(cap);
  const capOk =
    cap.trim() !== '' &&
    Number.isFinite(capValue) &&
    capValue >= 0.5 &&
    capValue <= 1000;

  // Until the settings arrive, a blank form would read as "key lost".
  if (!s) {
    return (
      <div className="pc-admin flex flex-col gap-y-3">
        <Container className="pc-ai-aurora flex items-center gap-x-4 px-6 py-5">
          <AiOrb size={44} />
          <Heading level="h2">{t('assistant.settings.title')}</Heading>
        </Container>
        <Container className="px-6 py-5">
          {settings.isError ? (
            <Text size="small" className="text-ui-fg-error">
              {t('assistant.loadError', { message: settings.error.message })}
            </Text>
          ) : (
            <LoadingSkeleton />
          )}
        </Container>
      </div>
    );
  }

  const status = !s?.openrouter_key.set
    ? { color: 'grey' as const, text: t('assistant.settings.keyNone') }
    : !s.openrouter_key.readable
      ? {
          color: 'orange' as const,
          text: t('assistant.settings.keyUnreadable'),
        }
      : {
          color: 'green' as const,
          text: t('assistant.settings.keySet', {
            last4: s.openrouter_key.last4,
          }),
        };

  return (
    <div className="pc-admin flex flex-col gap-y-3">
      <Container className="pc-ai-aurora flex items-center gap-x-4 px-6 py-5">
        <AiOrb size={44} />
        <div>
          <Heading level="h2">{t('assistant.settings.title')}</Heading>
          <Text size="small" className="text-ui-fg-subtle mt-1">
            {t('assistant.settings.subtitle')}
          </Text>
        </div>
      </Container>

      <Container className="flex flex-col gap-y-4 px-6 py-5">
        <div className="flex items-center justify-between">
          <div>
            <Heading level="h3">{t('assistant.settings.keyTitle')}</Heading>
            <Text size="small" className="text-ui-fg-subtle mt-1">
              {t('assistant.settings.keyHelp')}
            </Text>
          </div>
          <Badge color={status.color} size="small">
            {status.text}
          </Badge>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="ai-key"
            aria-label={t('assistant.settings.keyTitle')}
            type="password"
            autoComplete="new-password"
            placeholder="sk-or-v1-…"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="sm:flex-1"
          />
          <Button
            disabled={saving || key.trim().length < 20}
            onClick={async () => {
              if (await save({ openrouter_key: key.trim() })) setKey('');
            }}
          >
            {t('assistant.settings.saveKey')}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="small"
            disabled={!s?.openrouter_key.readable}
            onClick={() => void runTest()}
          >
            {t('assistant.settings.test')}
          </Button>
          <Button
            variant="transparent"
            size="small"
            disabled={saving || !s?.openrouter_key.set}
            onClick={() => {
              if (window.confirm(t('assistant.settings.removeConfirm'))) {
                void save({ openrouter_key: null });
              }
            }}
          >
            {t('assistant.settings.remove')}
          </Button>
          {test && (
            <Text size="small" className="text-ui-fg-subtle">
              {test}
            </Text>
          )}
        </div>
      </Container>

      <Container className="flex flex-col gap-y-4 px-6 py-5">
        <Heading level="h3">{t('assistant.settings.modelsTitle')}</Heading>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="flex flex-col gap-y-1.5">
            <Label size="small" htmlFor="ai-chat-model">
              {t('assistant.settings.chatModel')}
            </Label>
            <Input
              id="ai-chat-model"
              value={chatModel}
              onChange={(e) => setChatModel(e.target.value)}
            />
            <Text size="xsmall" className="text-ui-fg-muted">
              {t('assistant.settings.chatModelHelp')}
            </Text>
          </div>
          <div className="flex flex-col gap-y-1.5">
            <Label size="small" htmlFor="ai-image-model">
              {t('assistant.settings.imageModel')}
            </Label>
            <Input
              id="ai-image-model"
              value={imageModel}
              onChange={(e) => setImageModel(e.target.value)}
            />
            <Text size="xsmall" className="text-ui-fg-muted">
              {t('assistant.settings.imageModelHelp')}
            </Text>
          </div>
          <div className="flex flex-col gap-y-1.5">
            <Label size="small" htmlFor="ai-cap">
              {t('assistant.settings.cap')}
            </Label>
            <Input
              id="ai-cap"
              type="number"
              min={0.5}
              max={1000}
              step="any"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
            />
            <Text
              size="xsmall"
              className={capOk ? 'text-ui-fg-muted' : 'text-ui-fg-error'}
            >
              {t('assistant.settings.capHelp')}
            </Text>
          </div>
        </div>
        <div>
          <Button
            variant="secondary"
            disabled={saving || !s || !capOk}
            onClick={() =>
              void save({
                chat_model: chatModel.trim(),
                image_model: imageModel.trim(),
                daily_cap_usd: Number(cap),
              })
            }
          >
            {t('assistant.settings.save')}
          </Button>
        </div>
      </Container>

      {s && (
        <Container className="flex flex-col gap-y-4 px-6 py-5">
          <div className="flex flex-col gap-y-1">
            <Heading level="h3">{t('assistant.settings.voiceTitle')}</Heading>
            <Text size="small" className="text-ui-fg-subtle">
              {t('assistant.settings.voiceHelp')}
            </Text>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="flex flex-col gap-y-1.5">
              <Label size="small" htmlFor="ai-stt-model">
                {t('assistant.settings.sttModel')}
              </Label>
              <Input
                id="ai-stt-model"
                value={sttModel}
                onChange={(e) => setSttModel(e.target.value)}
              />
              <Text size="xsmall" className="text-ui-fg-muted">
                {t('assistant.settings.sttModelHelp')}
              </Text>
            </div>
            <div className="flex flex-col gap-y-1.5">
              <Label size="small" htmlFor="ai-voice-model">
                {t('assistant.settings.voiceModel')}
              </Label>
              <Input
                id="ai-voice-model"
                value={voiceModel}
                onChange={(e) => setVoiceModel(e.target.value)}
              />
              <Text size="xsmall" className="text-ui-fg-muted">
                {t('assistant.settings.voiceModelHelp')}
              </Text>
            </div>
            <div className="flex flex-col gap-y-1.5">
              <Label size="small" htmlFor="ai-voice">
                {t('assistant.settings.voice')}
              </Label>
              <div className="flex items-center gap-x-2">
                <Select value={voiceName} onValueChange={setVoiceName}>
                  <Select.Trigger id="ai-voice" className="flex-1">
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Content>
                    {s.voices.map((v) => (
                      <Select.Item key={v} value={v}>
                        {v}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select>
                <HearVoice
                  model={voiceModel}
                  voice={voiceName}
                  disabled={!s.openrouter_key.readable}
                />
              </div>
            </div>
          </div>
          <div>
            <Button
              variant="secondary"
              disabled={saving}
              onClick={() =>
                void save({
                  stt_model: sttModel.trim(),
                  voice_model: voiceModel.trim(),
                  voice: voiceName,
                })
              }
            >
              {t('assistant.settings.save')}
            </Button>
          </div>
        </Container>
      )}

      {s && <ImageStyleCard settings={s} save={save} />}
    </div>
  );
};

/** "Hear it": plays a short sample in the form's voice, saved or not. */
function HearVoice({
  model,
  voice,
  disabled,
}: {
  model: string;
  voice: string;
  disabled: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [playing, setPlaying] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);

  // Leaving the page stops the sample.
  useEffect(() => () => stopRef.current?.(), []);

  const play = async () => {
    // Made in the click: iOS only plays audio from a context made in a gesture.
    const player = new PcmPlayer();
    const ctl = new AbortController();
    const stop = () => {
      ctl.abort();
      player.stop();
    };
    stopRef.current = stop;
    setPlaying(true);
    try {
      await streamVoiceTest(
        {
          voice_model: model.trim(),
          voice,
          lang: i18n.language.startsWith('zh') ? 'zh' : 'en',
        },
        (e) => {
          if (e.type === 'audio') player.push(e.data);
          else if (e.type === 'error') toast.error(e.message);
        },
        ctl.signal,
      );
      player.finish();
    } catch {
      // Stopped, or the connection dropped.
      player.stop();
    }
    // A player whose audio never starts never ends.
    await Promise.race([
      player.ended,
      new Promise((r) => setTimeout(r, 30_000)),
    ]);
    player.stop();
    if (stopRef.current === stop) {
      stopRef.current = null;
      setPlaying(false);
    }
  };

  return (
    <Button
      variant="secondary"
      size="small"
      disabled={!playing && disabled}
      onClick={() => (playing ? stopRef.current?.() : void play())}
    >
      {playing
        ? t('assistant.settings.stopVoice', { defaultValue: 'Stop' })
        : t('assistant.settings.hearVoice', { defaultValue: 'Hear it' })}
    </Button>
  );
}

export default AiSettingsPage;
