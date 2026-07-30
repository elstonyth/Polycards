import { describe, expect, it } from 'vitest';
import { pillVariants } from '@/components/ui/pill';

// pillVariants replaced a `cva()` call. cva supplied the defaults implicitly via
// `defaultVariants`; here they are `??` fallbacks, and a silently-dropped default
// is invisible in review (the class string still looks plausible) but ships a
// pill with no background or no height. These pin both.
describe('pillVariants', () => {
  it('defaults to primary + md when called with nothing', () => {
    const cls = pillVariants();
    expect(cls).toContain('bg-neutral-50');
    expect(cls).toContain('h-11');
    expect(cls).toContain('rounded-full');
  });

  it('falls back per-key when only one variant is given', () => {
    expect(pillVariants({ size: 'lg' })).toContain('bg-neutral-50');
    expect(pillVariants({ size: 'lg' })).toContain('h-12');
    expect(pillVariants({ variant: 'ghost' })).toContain('h-11');
  });

  it('applies the requested variant and size', () => {
    const cls = pillVariants({ variant: 'secondary', size: 'sm' });
    expect(cls).toContain('bg-neutral-800');
    expect(cls).toContain('h-10');
    expect(cls).not.toContain('bg-neutral-50');
  });

  it('treats null like an omitted value (callers pass optional props through)', () => {
    expect(pillVariants({ variant: null, size: null })).toBe(pillVariants());
  });
});
