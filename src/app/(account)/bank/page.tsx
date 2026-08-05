import type { Metadata } from 'next';
import { AccountHeader } from '@/components/account/ui';
import { BankAccountsClient } from './BankAccountsClient';

export const metadata: Metadata = {
  title: 'Bank Accounts',
  description: 'Save the bank accounts your withdrawals go to.',
};

export default function BankPage() {
  return (
    <>
      <AccountHeader
        title="Bank accounts"
        sub="Where your withdrawals are paid out."
      />
      <BankAccountsClient />
    </>
  );
}
