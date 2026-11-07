import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Heading, Hint, Input, Label, Text } from '@medusajs/ui';
import {
  SETUP_PATH,
  type SignInStep,
  TwoStepError,
  adminUrl,
  afterSignIn,
  answerCode,
  digitsOnly,
  signInWithPassword,
  startSession,
} from '../../lib/two-step';

// The admin sign-in with two-step sign-in (owner, 2026-11-07): password, then
// the authenticator app's 6-digit code or a backup code. Public, so it opens
// signed out; every visit to the dashboard's own login page, which has no
// code step, comes here (lib/login-redirect.ts).
export const config = { public: true };

type CodeStep = Extract<SignInStep, { kind: 'code' }>;

export default function SignInPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<CodeStep | null>(null);
  const [code, setCode] = useState('');
  const [backup, setBackup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A full load, so the dashboard starts fresh on the new session.
  const finish = async (token: string, needsSetup: boolean) => {
    await startSession(token);
    const redirect = new URLSearchParams(window.location.search).get(
      'redirect',
    );
    window.location.assign(
      adminUrl(needsSetup ? SETUP_PATH : afterSignIn(redirect)),
    );
  };

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = await signInWithPassword(email.trim(), password);
      if (next.kind === 'signed-in') {
        // No authenticator yet: straight to its setup.
        await finish(next.token, true);
        return;
      }
      setStep(next);
      setCode('');
    } catch (err) {
      setError(
        err instanceof TwoStepError && err.status === 401
          ? t('pcTwoStep.wrongPassword')
          : (err as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    if (!step) return;
    setBusy(true);
    setError(null);
    try {
      const token = await answerCode(
        step,
        backup ? 'recovery_code' : 'totp',
        code.trim(),
      );
      await finish(token, false);
    } catch (err) {
      const message = (err as Error).message ?? '';
      // A challenge lasts five minutes and five tries; past either, only a new
      // password step helps.
      if (/expired|attempt|not found/i.test(message)) {
        setStep(null);
        setPassword('');
        setError(t('pcTwoStep.startAgain'));
      } else {
        setError(t('pcTwoStep.wrongCode'));
      }
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh w-full items-center justify-center bg-ui-bg-subtle px-4">
      <div className="w-full max-w-[360px] rounded-lg border border-ui-border-base bg-ui-bg-base p-6 shadow-elevation-card-rest">
        {step ? (
          <form className="flex flex-col gap-y-4" onSubmit={submitCode}>
            <div className="flex flex-col gap-y-1">
              <Heading>{t('pcTwoStep.codeTitle')}</Heading>
              <Text size="small" className="text-ui-fg-subtle">
                {t('pcTwoStep.codeHint')}
              </Text>
            </div>
            <div className="flex flex-col gap-y-2">
              <Label htmlFor="two-step-code">
                {backup ? t('pcTwoStep.backupLabel') : t('pcTwoStep.codeLabel')}
              </Label>
              <Input
                id="two-step-code"
                autoFocus
                autoComplete="one-time-code"
                inputMode={backup ? 'text' : 'numeric'}
                value={code}
                onChange={(e) =>
                  setCode(
                    backup
                      ? e.target.value.slice(0, 64)
                      : digitsOnly(e.target.value),
                  )
                }
              />
            </div>
            {error && <Hint variant="error">{error}</Hint>}
            <Button
              type="submit"
              isLoading={busy}
              disabled={backup ? code.trim() === '' : code.length !== 6}
            >
              {t('pcTwoStep.signIn')}
            </Button>
            <div className="flex justify-between">
              <Button
                type="button"
                variant="transparent"
                size="small"
                onClick={() => {
                  setBackup(!backup);
                  setCode('');
                  setError(null);
                }}
              >
                {backup ? t('pcTwoStep.useApp') : t('pcTwoStep.useBackup')}
              </Button>
              <Button
                type="button"
                variant="transparent"
                size="small"
                onClick={() => {
                  setStep(null);
                  setError(null);
                }}
              >
                {t('pcTwoStep.back')}
              </Button>
            </div>
          </form>
        ) : (
          <form className="flex flex-col gap-y-4" onSubmit={submitPassword}>
            <Heading>{t('pcTwoStep.signInTitle')}</Heading>
            <div className="flex flex-col gap-y-2">
              <Label htmlFor="sign-in-email">{t('pcTwoStep.email')}</Label>
              <Input
                id="sign-in-email"
                type="email"
                autoComplete="username"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-y-2">
              <Label htmlFor="sign-in-password">
                {t('pcTwoStep.password')}
              </Label>
              <Input
                id="sign-in-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && <Hint variant="error">{error}</Hint>}
            <Button
              type="submit"
              isLoading={busy}
              disabled={email.trim() === '' || password === ''}
            >
              {t('pcTwoStep.continue')}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
