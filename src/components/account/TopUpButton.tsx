'use client';

import { Plus } from 'lucide-react';
import { useTopUp } from '@/components/app-shell/TopUpProvider';
import { Pill } from '@/components/ui/pill';

export function TopUpButton({
  className = 'flex-1',
  size,
}: {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const { openTopUp } = useTopUp();
  return (
    <Pill onClick={openTopUp} size={size} className={className}>
      <Plus className="h-4 w-4" strokeWidth={3} aria-hidden />
      Top Up
    </Pill>
  );
}
