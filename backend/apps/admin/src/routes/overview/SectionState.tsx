import { useTranslation } from 'react-i18next';
import { Button, Text } from '@medusajs/ui';

/** One section failed to load: say so and offer a retry, the rest stays up. */
export const SectionError = ({ onRetry }: { onRetry: () => void }) => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-3 px-6 py-6">
      <Text size="small" className="text-ui-fg-subtle">
        {t('dashboard.loadError')}
      </Text>
      <Button size="small" variant="secondary" onClick={onRetry}>
        {t('dashboard.retry')}
      </Button>
    </div>
  );
};
