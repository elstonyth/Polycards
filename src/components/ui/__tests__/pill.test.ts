import { describe, expect, it } from 'vitest';
import { pillVariants } from '@/components/ui/pill';

// pillVariants replaced a `cva()` call. cva supplied the defaults implicitly via
// `defaultVariants`; here they are `??` fallbacks, and a silently-dropped default
// is invisible in review (the class string still looks plausible) but ships a
// pill with no background or no height. These pin both.
describe('pillVariants', () => {
  it('applies both lookups, defaulting each key independently', () => {
    expect(pillVariants()).toContain('bg-neutral-50'); // variant default
    expect(pillVariants()).toContain('h-11'); // size default
    expect(pillVariants({ size: 'lg' })).toContain('bg-neutral-50'); // still defaults variant
    expect(pillVariants({ variant: 'secondary', size: 'sm' })).toContain(
      'bg-neutral-800',
    );
    expect(pillVariants({ variant: 'secondary', size: 'sm' })).toContain(
      'h-10',
    );
  });
});
