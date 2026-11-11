import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Container,
  Heading,
  Text,
  toast,
  usePrompt,
} from '@medusajs/ui';
import { defineWidgetConfig } from '@mercurjs/dashboard-sdk';
import { resetTwoStep } from '../lib/two-step';

type Props = { data: { id: string; email: string } };

// On an admin user's page: a Super Admin resets their two-step sign-in when
// they lost or changed their phone (owner, 2026-11-07). The backend refuses
// anyone else and audits the reset (admin/users/[id]/mfa/reset).
export function UserTwoStepReset({ data }: Props) {
  const { t } = useTranslation();
  const prompt = usePrompt();
  const [busy, setBusy] = useState(false);

  const reset = async () => {
    const ok = await prompt({
      title: t('pcTwoStep.resetButton'),
      description: t('pcTwoStep.resetConfirm', { email: data.email }),
    });
    if (!ok) return;
    setBusy(true);
    try {
      await resetTwoStep(data.id);
      toast.success(t('pcTwoStep.resetDone'));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Container className="flex items-center justify-between gap-x-4 px-6 py-4">
      <div className="flex flex-col gap-y-1">
        <Heading level="h2">{t('pcTwoStep.resetTitle')}</Heading>
        <Text size="small" className="text-ui-fg-subtle">
          {t('pcTwoStep.resetBody')}
        </Text>
      </div>
      <Button variant="secondary" size="small" isLoading={busy} onClick={reset}>
        {t('pcTwoStep.resetButton')}
      </Button>
    </Container>
  );
}

export const config = defineWidgetConfig({
  zone: 'users.detail.main.after',
});
export default UserTwoStepReset;
