import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * The PixelSlot pill button (DESIGN.md §5 "Buttons") — the single source of truth
 * for what was 20+ hand-rolled copies of the same `rounded-full` string. Baked
 * in are the states the copies dropped: a focus-visible ring, disabled styling,
 * and a reduced-motion-safe press.
 *
 * `<Pill>` renders a <button>. For links/spans, spread the classes onto the
 * element directly: `<Link className={cn(pillVariants({ variant }), extra)} />`.
 */
const pillVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-full text-sm font-semibold whitespace-nowrap outline-none select-none transition-[background-color,color,transform] active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950 disabled:pointer-events-none motion-reduce:transition-[background-color,color] motion-reduce:active:scale-100',
  {
    variants: {
      variant: {
        primary:
          'bg-neutral-50 text-neutral-950 hover:bg-white disabled:opacity-40',
        secondary:
          'bg-neutral-800 text-white hover:bg-neutral-700 disabled:opacity-50',
        ghost:
          'border border-white/10 bg-white/5 text-neutral-200 hover:bg-white/10 disabled:opacity-50',
      },
      size: {
        sm: 'h-10 gap-1.5 px-4',
        md: 'h-11 gap-1.5 px-5',
        lg: 'h-12 gap-2 px-6',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
);

type PillProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof pillVariants>;

function Pill({
  className,
  variant,
  size,
  type = 'button',
  ...props
}: PillProps) {
  return (
    <button
      type={type}
      className={cn(pillVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Pill, pillVariants };
