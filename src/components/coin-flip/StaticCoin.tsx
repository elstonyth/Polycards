import Image from 'next/image';

export function StaticCoin({ won = true }: { won?: boolean }) {
  return (
    <div
      aria-hidden
      className="mx-auto flex h-40 w-40 items-center justify-center rounded-full border-[5px] border-neutral-400 bg-neutral-900 shadow-[inset_0_0_0_3px_#444,inset_0_0_32px_#000,0_24px_32px_#000] sm:h-48 sm:w-48"
    >
      <div
        className={
          won ? 'relative h-20 w-16 overflow-hidden' : 'relative h-10 w-32'
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
