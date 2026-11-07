import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Checkbox,
  Heading,
  Hint,
  Input,
  Label,
  Text,
} from '@medusajs/ui';
import { toDataURL } from 'qrcode';
import {
  type Enrollment,
  SIGN_IN_PATH,
  TwoStepError,
  adminUrl,
  confirmAuthenticator,
  digitsOnly,
  groupKey,
  makeBackupCodes,
  startAuthenticator,
} from '../../lib/two-step';

// Two-step sign-in setup (owner, 2026-11-07): a login without an authenticator
// lands here (lib/login-redirect.ts) and can reach nothing else of the admin
// until done. Scan the QR code, confirm one code, keep the backup codes.
// Public, because the dashboard shell's own calls are refused until then.
export const config = { public: true };

export default function TwoStepSetupPage() {
  const { t } = useTranslation();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<'key' | 'codes' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // StrictMode runs effects twice in dev: one new authenticator per visit.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    startAuthenticator()
      .then(async (next) => {
        setEnrollment(next);
        setQr(await toDataURL(next.otpauthUrl, { margin: 1, width: 220 }));
      })
      .catch((err: unknown) => {
        if (err instanceof TwoStepError && err.status === 401) {
          window.location.assign(adminUrl(SIGN_IN_PATH));
        } else if (err instanceof TwoStepError && err.status === 409) {
          setError(t('pcTwoStep.alreadySetUp'));
        } else {
          setError((err as Error).message);
        }
      });
  }, [t]);

  const copy = async (what: 'key' | 'codes', text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(what);
  };

  const download = (list: string[]) => {
    const blob = new Blob(
      [`Polycards Admin backup codes\n\n${list.join('\n')}\n`],
      { type: 'text/plain' },
    );
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'polycards-admin-backup-codes.txt';
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    if (!enrollment) return;
    setBusy(true);
    setError(null);
    try {
      await confirmAuthenticator(enrollment.factorId, code);
      setCodes(await makeBackupCodes());
    } catch {
      setError(t('pcTwoStep.wrongCode'));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh w-full items-center justify-center bg-ui-bg-subtle px-4 py-8">
      <div className="flex w-full max-w-[420px] flex-col gap-y-5 rounded-lg border border-ui-border-base bg-ui-bg-base p-6 shadow-elevation-card-rest">
        {codes ? (
          <>
            <div className="flex flex-col gap-y-1">
              <Heading>{t('pcTwoStep.backupTitle')}</Heading>
              <Text size="small" className="text-ui-fg-subtle">
                {t('pcTwoStep.backupIntro')}
              </Text>
            </div>
            <ol className="flex flex-col gap-y-1.5 rounded-md bg-ui-bg-subtle p-3 font-mono text-sm">
              {codes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ol>
            <div className="flex gap-x-2">
              <Button
                variant="secondary"
                size="small"
                onClick={() => copy('codes', codes.join('\n'))}
              >
                {copied === 'codes'
                  ? t('pcTwoStep.copied')
                  : t('pcTwoStep.copyAll')}
              </Button>
              <Button
                variant="secondary"
                size="small"
                onClick={() => download(codes)}
              >
                {t('pcTwoStep.download')}
              </Button>
            </div>
            <div className="flex items-center gap-x-2">
              <Checkbox
                id="two-step-saved"
                checked={saved}
                onCheckedChange={(v) => setSaved(v === true)}
              />
              <Label htmlFor="two-step-saved">{t('pcTwoStep.saved')}</Label>
            </div>
            <Button
              disabled={!saved}
              onClick={() => window.location.assign(adminUrl('/'))}
            >
              {t('pcTwoStep.toAdmin')}
            </Button>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-y-1">
              <Heading>{t('pcTwoStep.setupTitle')}</Heading>
              <Text size="small" className="text-ui-fg-subtle">
                {t('pcTwoStep.setupIntro')}
              </Text>
            </div>
            {enrollment ? (
              <form className="flex flex-col gap-y-4" onSubmit={confirm}>
                <Text size="small">{t('pcTwoStep.scan')}</Text>
                {qr && (
                  <img
                    src={qr}
                    alt="QR code"
                    width={220}
                    height={220}
                    className="self-center rounded-md border border-ui-border-base"
                  />
                )}
                <div className="flex flex-col gap-y-1">
                  <Text size="small" className="text-ui-fg-subtle">
                    {t('pcTwoStep.manual')}
                  </Text>
                  <div className="flex items-center gap-x-2">
                    <code className="min-w-0 flex-1 break-all rounded bg-ui-bg-subtle px-2 py-1 font-mono text-sm">
                      {groupKey(enrollment.secret)}
                    </code>
                    <Button
                      type="button"
                      variant="secondary"
                      size="small"
                      className="shrink-0"
                      onClick={() => copy('key', enrollment.secret)}
                    >
                      {copied === 'key'
                        ? t('pcTwoStep.copied')
                        : t('pcTwoStep.copyKey')}
                    </Button>
                  </div>
                </div>
                <div className="flex flex-col gap-y-2">
                  <Label htmlFor="two-step-setup-code">
                    {t('pcTwoStep.enterCode')}
                  </Label>
                  <Input
                    id="two-step-setup-code"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    value={code}
                    onChange={(e) => setCode(digitsOnly(e.target.value))}
                  />
                </div>
                {error && <Hint variant="error">{error}</Hint>}
                <Button
                  type="submit"
                  isLoading={busy}
                  disabled={code.length !== 6}
                >
                  {t('pcTwoStep.turnOn')}
                </Button>
              </form>
            ) : error ? (
              <>
                <Hint variant="error">{error}</Hint>
                <Button onClick={() => window.location.assign(adminUrl('/'))}>
                  {t('pcTwoStep.toAdmin')}
                </Button>
              </>
            ) : (
              <Text size="small">{t('pcTwoStep.loading')}</Text>
            )}
          </>
        )}
      </div>
    </div>
  );
}
