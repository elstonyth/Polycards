import { normalizeRealName } from '../real-name';

describe('normalizeRealName', () => {
  it.each([
    ['Tan Ah Kow', 'Tan Ah Kow'],
    ['  MUHAMMAD   ALI  BIN  ABU  ', 'MUHAMMAD ALI BIN ABU'],
    ['Siti Nur @ Aisyah', 'Siti Nur @ Aisyah'],
    ['Rajesh a/l Kumar', 'Rajesh a/l Kumar'],
    ["O'Neil Jean-Luc", "O'Neil Jean-Luc"],
    ['陈大文', '陈大文'],
    ['Nguyễn Văn An', 'Nguyễn Văn An'],
  ])('accepts %j', (input, out) => {
    expect(normalizeRealName(input)).toBe(out);
  });

  it.each([
    [''],
    ['ab'],
    ['   '],
    ['Tan 123'],
    ['-Tan'],
    ['Tan 😀'],
    ['https://x.y'],
    ['a'.repeat(101)],
  ])('refuses %j', (input) => {
    expect(normalizeRealName(input)).toBeNull();
  });

  it('refuses a non-string', () => {
    expect(normalizeRealName(null)).toBeNull();
    expect(normalizeRealName(42)).toBeNull();
    expect(normalizeRealName({ name: 'Tan Ah Kow' })).toBeNull();
  });
});
