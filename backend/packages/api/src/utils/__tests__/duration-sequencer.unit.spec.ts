// Lives in the unit tier (testMatch is src/**/__tests__) so CI guards the
// CI shard splitter: a split that drops or repeats a file stays green on
// every shard while silently skipping tests.
import { assignShards } from '../../../integration-tests/duration-sequencer';
import timings from '../../../integration-tests/test-timings.json';

const recorded = timings as Record<string, number>;
const files = Object.keys(recorded);

function loads(keys: string[], shardCount: number) {
  const shardOf = assignShards(keys, recorded, shardCount);
  const total = Array<number>(shardCount).fill(0);
  keys.forEach((k) => (total[shardOf.get(k)!] += recorded[k] ?? 0));
  return { shardOf, total };
}

describe('assignShards', () => {
  it.each([2, 10])('puts every file in exactly one of %i shards', (n) => {
    const { shardOf } = loads(files, n);
    expect(shardOf.size).toBe(files.length);
    for (const s of shardOf.values()) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(n);
    }
  });

  it('gives the same split whatever order jest lists the files in', () => {
    const a = assignShards(files, recorded, 10);
    const b = assignShards([...files].reverse(), recorded, 10);
    expect([...b.entries()].sort()).toEqual([...a.entries()].sort());
  });

  it('keeps the slowest http shard within 10% of the mean', () => {
    const http = files.filter((f) => f.startsWith('integration-tests/http/'));
    const { total } = loads(http, 10);
    const mean = total.reduce((s, t) => s + t, 0) / total.length;
    expect(Math.max(...total)).toBeLessThan(mean * 1.1);
  });

  it('still places files it has no timing for', () => {
    const keys = [
      ...files.slice(0, 5),
      'src/new/__tests__/brand-new.unit.spec.ts',
    ];
    expect(assignShards(keys, recorded, 2).size).toBe(keys.length);
  });
});
