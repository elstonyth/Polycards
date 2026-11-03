import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Container, Text } from '@medusajs/ui';
import { useGoodsReceiveNote } from '../../../../lib/queries';
import { httpStatus } from '../../../../lib/admin-rest';
import { LoadingSkeleton } from '../../../../components/LoadingSkeleton';
import { GrnForm } from '../../grn-form';

// ponytail: no config export — reached from the GRN page's Edit button.

// Only an open GRN is edited here; the server refuses the rest under the
// GRN's lock either way, this just says so before anyone types.
const EditGoodsReceiveNotePage = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const { data, isError, error } = useGoodsReceiveNote(id ?? null);
  const grn = data?.goods_receive_note;

  if (grn?.status === 'open') return <GrnForm editing={grn} />;
  if (!grn && !isError) return <LoadingSkeleton />;
  return (
    <Container className="flex flex-col items-start gap-y-2 px-6 py-4">
      <Text className="text-ui-fg-subtle">
        {!grn
          ? httpStatus(error) === 404
            ? t('grn.notFound')
            : t('grn.detailLoadError')
          : t('grn.notEditable', {
              no: grn.display_no,
              status: t(`grn.status.${grn.status}`),
            })}
      </Text>
      <Link
        to={grn ? `/goods-receive-notes/${grn.id}` : '/goods-receive-notes'}
        className="text-ui-fg-interactive text-sm hover:underline"
      >
        {grn ? grn.display_no : t('grn.back')}
      </Link>
    </Container>
  );
};

export default EditGoodsReceiveNotePage;
