import type { Metadata } from 'next';
import { AccountHeader } from '@/components/account/ui';
import { getRealName } from '@/lib/data/customer';
import { BankAccountsClient } from './BankAccountsClient';

export const metadata: Metadata = {
  title: 'Bank Accounts',
  description: 'Save the bank accounts your withdrawals go to.',
};

export default async function BankPage() {
  // A bank is paid to the account's real name (owner, 2026-11-16), shown on the
  // form and never typed. The layout's real-name gate shares this cached read.
  const realName = await getRealName();
  return (
    <>
      <AccountHeader
        title="Bank accounts"
        sub="Where your withdrawals are paid out."
      />
      <BankAccountsClient realName={realName} />
    </>
  );
}
