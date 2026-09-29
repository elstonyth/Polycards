import { MedusaError } from '@medusajs/framework/utils';
import { describeScope, parseWindow, resolveGroupScope } from '../params';

// The message of the INVALID_DATA (400) error fn throws, or a failure marker.
function invalid(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof MedusaError && e.type === MedusaError.Types.INVALID_DATA
      ? e.message
      : `wrong error: ${String(e)}`;
  }
  return 'no error';
}

describe('parseWindow', () => {
  it('normalises both bounds to ISO', () => {
    expect(
      parseWindow({
        from: '2026-09-28T16:00:00Z',
        to: '2026-09-29T16:00:00.000Z',
      }),
    ).toEqual({
      from: '2026-09-28T16:00:00.000Z',
      to: '2026-09-29T16:00:00.000Z',
    });
  });

  it('treats absent and empty bounds as open', () => {
    expect(parseWindow({})).toEqual({ from: undefined, to: undefined });
    expect(parseWindow({ from: '', to: '' })).toEqual({
      from: undefined,
      to: undefined,
    });
  });

  it.each([
    [{ from: 'yesterday' }, 'from must be'],
    [{ to: ['2026-09-28T00:00:00Z', '2026-09-29T00:00:00Z'] }, 'to must be'],
    [{ from: '2026-09-29T00:00:00Z', to: '2026-09-28T00:00:00Z' }, 'before'],
    [{ from: '2026-09-29T00:00:00Z', to: '2026-09-29T00:00:00Z' }, 'before'],
  ])('rejects %p', (query, message) => {
    expect(invalid(() => parseWindow(query))).toContain(message);
  });

  it('enforces required bounds and the day cap', () => {
    expect(
      invalid(() =>
        parseWindow({ from: '2026-09-01T00:00:00Z' }, { required: true }),
      ),
    ).toContain('both required');
    expect(
      invalid(() =>
        parseWindow(
          { from: '2026-01-01T00:00:00Z', to: '2026-04-04T00:00:01Z' },
          { maxDays: 93 },
        ),
      ),
    ).toContain('93 days');
    expect(
      parseWindow(
        { from: '2026-01-01T00:00:00Z', to: '2026-04-04T00:00:00Z' },
        { maxDays: 93 },
      ).to,
    ).toBe('2026-04-04T00:00:00.000Z');
  });
});

const GROUPS = [
  { id: 'g_def', name: 'DEFAULT', metadata: { is_default: true } },
  { id: 'g_house', name: 'House', metadata: { is_default: true } },
  { id: 'g_partners', name: 'Partners', metadata: null },
];

describe('resolveGroupScope', () => {
  it.each([undefined, '', 'all', ' ALL '])('%p means everyone', (raw) => {
    expect(resolveGroupScope(raw, GROUPS)).toEqual({ kind: 'all' });
  });

  it.each(['default', 'Default', 'DEFAULT', 'house'])(
    '%p means the default group',
    (raw) => {
      expect(resolveGroupScope(raw, GROUPS)).toEqual({ kind: 'default' });
    },
  );

  it('matches a named group case-insensitively', () => {
    expect(resolveGroupScope(' partners ', GROUPS)).toEqual({
      kind: 'group',
      id: 'g_partners',
      name: 'Partners',
    });
  });

  it('rejects an unknown group and lists the real ones', () => {
    expect(invalid(() => resolveGroupScope('Whales', GROUPS))).toBe(
      'Unknown player group "Whales". Use all, default, or one of: DEFAULT, House, Partners.',
    );
  });

  it('rejects a repeated group param', () => {
    expect(
      invalid(() => resolveGroupScope(['all', 'default'], GROUPS)),
    ).toContain('one value');
  });
});

describe('describeScope', () => {
  it('names the group the numbers cover', () => {
    expect(describeScope({ kind: 'all' }).group).toBe('all');
    expect(describeScope({ kind: 'default' }).group).toBe('DEFAULT');
    expect(
      describeScope({ kind: 'group', id: 'g', name: 'Partners' }).group,
    ).toBe('Partners');
  });
});
