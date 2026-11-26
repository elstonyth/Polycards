import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { homePreviewOn } from '@/lib/preview-switch';
import { AudioPreview } from './AudioPreview';

export default async function AudioPreviewPage() {
  // The switch is read per request: a build does not know where it will run.
  await connection();
  if (!homePreviewOn()) notFound();
  return <AudioPreview />;
}
