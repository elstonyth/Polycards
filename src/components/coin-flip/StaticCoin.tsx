import Image from 'next/image';

export function StaticCoin({
  won = true,
  compact = false,
}: {
  won?: boolean;
  compact?: boolean;
}) {
  return (
    <div
      aria-hidden
      className={`mx-auto flex items-center justify-center rounded-full border-[3px] border-neutral-500 bg-neutral-900 shadow-[inset_0_0_0_2px_#333,inset_0_0_24px_#0a0a0a] ${compact ? 'size-28' : 'size-40 sm:size-48'}`}
    >
      <div
        className={
          won
            ? `relative h-20 w-16 overflow-hidden ${compact ? 'scale-75' : ''}`
            : 'relative h-10 w-32'
        }
      >
        <Image
          src="/branding/polycards-logo.png"
          alt=""
          width={368}
          height={100}
          className={won ? 'h-20 w-auto max-w-none' : 'h-auto w-full'}
          priority
        />
      </div>
    </div>
  );
}
