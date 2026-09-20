import { notFound } from 'next/navigation';
import { AudioPreview } from './AudioPreview';

export default function AudioPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return <AudioPreview />;
}
