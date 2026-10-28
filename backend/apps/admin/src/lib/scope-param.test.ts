import { describe, expect, it } from 'vitest';
import { scopeFromParam } from './scope-param';

describe('scopeFromParam', () => {
  it('opens on real customers unless the link says all', () => {
    expect(scopeFromParam(null)).toBe('default');
    expect(scopeFromParam('all')).toBe('all');
    expect(scopeFromParam('default')).toBe('default');
    // A hand-edited link never widens to everyone by accident.
    expect(scopeFromParam('everyone')).toBe('default');
    expect(scopeFromParam('')).toBe('default');
  });
});
