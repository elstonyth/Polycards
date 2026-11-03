import { nameGroups } from '../name-groups';

// Accounts that used one holder name read one group, even when they are linked
// only through a third account that used both names.
describe('nameGroups', () => {
  it('merges through an account that used both names, numbering 1, 2, 3', () => {
    const groups = nameGroups([
      { customer_id: 'x', keys: ['alice'] },
      { customer_id: 'y', keys: ['bob'] },
      { customer_id: 'z', keys: ['alice', 'bob'] },
      { customer_id: 'w', keys: ['carol'] },
      { customer_id: 'v', keys: null },
    ]);
    expect(groups.get('x')).toBe(groups.get('y'));
    expect(groups.get('z')).toBe(groups.get('x'));
    expect(groups.get('x')).toBe(1);
    expect(groups.get('w')).toBe(2);
    expect(groups.get('v')).toBeNull();
  });
});
