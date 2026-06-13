import type { Metadata } from 'next';
import { Suspense } from 'react';
import ResetPasswordClient from './ResetPasswordClient';

export const metadata: Metadata = {
  title: 'Reset password — Phygitals',
  description: 'Choose a new password for your account.',
  // Tokenized links must never end up in a search index.
  robots: { index: false, follow: false },
};

export default function ResetPasswordPage() {
  return (
    // useSearchParams (the token/email live in the query string) requires a
    // Suspense boundary around the client component.
    <Suspense fallback={null}>
      <ResetPasswordClient />
    </Suspense>
  );
}
