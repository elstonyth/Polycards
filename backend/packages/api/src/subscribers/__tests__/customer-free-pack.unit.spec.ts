import handler from '../customer-free-pack';

// The stamp is UNCONDITIONAL: every customer.created gets it, and eligibility to
// CLAIM is decided later (an active free pack must exist). So these cases pin the
// mechanics — payload shape, id hygiene, and the never-throws contract — not a
// business predicate, because there isn't one to gate on.

function buildHarness(markFreePackAvailable: jest.Mock) {
  const warn = jest.fn<void, [string]>();
  // `warn` is built ONCE, not per resolve() call: a fresh jest.fn() per call is
  // unassertable, and the fail-safe case below has to prove the handler warned
  // rather than swallowing into an empty catch.
  const packs = { markFreePackAvailable };
  const container = {
    resolve: (key: string) => (key === 'logger' ? { warn } : packs),
  };
  return { warn, packs, container };
}

const run = (
  data: unknown,
  container: { resolve: (k: string) => unknown },
): Promise<void> =>
  handler({ event: { data }, container } as unknown as Parameters<
    typeof handler
  >[0]);

describe('customer-free-pack subscriber', () => {
  it('stamps every created customer (array payload)', async () => {
    const mark = jest.fn();
    const { packs, container } = buildHarness(mark);

    await run([{ id: 'cus_1' }, { id: 'cus_2' }], container);

    expect(packs.markFreePackAvailable).toHaveBeenCalledTimes(2);
    // createCustomersWorkflow hands emitEventStep an ARRAY, so a bulk create must
    // not silently stamp only the first (or stamp `undefined` twice and still
    // satisfy a bare call-count assertion).
    expect(packs.markFreePackAvailable).toHaveBeenNthCalledWith(1, 'cus_1');
    expect(packs.markFreePackAvailable).toHaveBeenNthCalledWith(2, 'cus_2');
  });

  it('stamps a single created customer (object payload)', async () => {
    const mark = jest.fn();
    const { packs, container } = buildHarness(mark);

    await run({ id: 'cus_1' }, container);

    expect(packs.markFreePackAvailable).toHaveBeenCalledTimes(1);
    expect(packs.markFreePackAvailable).toHaveBeenCalledWith('cus_1');
  });

  // A blank/absent id would reach markFreePackAvailable as an advisory-lock key
  // and an account-state row for a customer that does not exist.
  it('skips blank, missing, and non-string ids', async () => {
    const mark = jest.fn();
    const { packs, container } = buildHarness(mark);

    await run([{ id: 'cus_1' }, { id: '' }, {}, null, { id: 42 }], container);

    expect(packs.markFreePackAvailable).toHaveBeenCalledTimes(1);
    expect(packs.markFreePackAvailable).toHaveBeenCalledWith('cus_1');
  });

  it('resolves nothing when the payload carries no usable id', async () => {
    const mark = jest.fn();
    const { packs, container } = buildHarness(mark);

    await expect(run([], container)).resolves.toBeUndefined();

    expect(packs.markFreePackAvailable).not.toHaveBeenCalled();
  });

  it('never throws on stamp failure (fail-safe, mirrors phone-verified)', async () => {
    const mark = jest.fn().mockRejectedValue(new Error('db down'));
    const { warn, container } = buildHarness(mark);

    // Rejecting would retry-loop the event bus over an account that already
    // exists; a missed stamp only costs that account its free pack.
    await expect(run({ id: 'cus_1' }, container)).resolves.toBeUndefined();

    // Asserted so an empty `catch {}` cannot pass this case silently.
    const logged = warn.mock.calls.map((c) => c[0]).join('\n');
    expect(logged).toContain('[customer-free-pack]');
    expect(logged).toContain('db down');
  });
});
