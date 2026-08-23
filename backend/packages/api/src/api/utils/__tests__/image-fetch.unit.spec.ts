import { fetchBytes, isAllowedImageUrl } from '../image-fetch';

// The size cap is the point of this file. It used to be
// `Buffer.from(await resp.arrayBuffer())` followed by a length check — i.e. the
// body was fully resident BEFORE it was measured, so a hostile or misconfigured
// origin could pin gigabytes on a 512 MB-class box and only then be refused.
// These tests pin the streaming bound and the two ways a body can lie about its
// size (an honest Content-Length, and no Content-Length at all).

const realFetch = global.fetch;
const CHUNK = 1024 * 1024;
// Far over MAX_FETCH_BYTES (20 MB), not just over it: the abort has to be
// demonstrably EARLY, and a 21 MB body in 1 MB chunks trips the cap on its
// very last chunk, which proves nothing.
const OVER = 200 * CHUNK;

/** A response whose body streams `size` bytes in 1 MB chunks, counting how many
 *  were actually pulled — so a test can prove the read stopped early. */
const streamed = (size: number, opts: { declare: boolean }) => {
  const state = { delivered: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.delivered >= size) return controller.close();
      const n = Math.min(CHUNK, size - state.delivered);
      state.delivered += n;
      controller.enqueue(new Uint8Array(n));
    },
  });
  return {
    state,
    resp: new Response(body, {
      status: 200,
      headers: opts.declare ? { 'content-length': String(size) } : {},
    }),
  };
};

afterEach(() => {
  global.fetch = realFetch;
});

describe('fetchBytes size cap', () => {
  it('returns the bytes for a body under the cap', async () => {
    global.fetch = (async () =>
      new Response(new Uint8Array(1024))) as unknown as typeof fetch;

    const bytes = await fetchBytes('https://cdn.example/card.webp');

    expect(bytes).not.toBeNull();
    expect(bytes!.length).toBe(1024);
  });

  it('refuses an over-cap body declared by Content-Length without reading it', async () => {
    const { state, resp } = streamed(OVER, { declare: true });
    global.fetch = (async () => resp) as unknown as typeof fetch;

    expect(await fetchBytes('https://cdn.example/huge.webp')).toBeNull();
    // The whole point: the 200 MB was never pulled off the wire. Not zero —
    // a ReadableStream fills its one-chunk queue eagerly on construction — but
    // bounded by that single chunk rather than by the body's real size.
    expect(state.delivered).toBeLessThanOrEqual(CHUNK);
  });

  it('refuses an over-cap body with NO Content-Length, stopping mid-stream', async () => {
    // Chunked transfer, or a lying server. The running total is the real bound.
    const { state, resp } = streamed(OVER, { declare: false });
    global.fetch = (async () => resp) as unknown as typeof fetch;

    expect(await fetchBytes('https://cdn.example/chunked.webp')).toBeNull();
    expect(state.delivered).toBeGreaterThan(0);
    // Aborted once the running total crossed the cap, not after the full 200 MB.
    expect(state.delivered).toBeLessThanOrEqual(22 * CHUNK);
  });

  it('returns null for an empty body', async () => {
    global.fetch = (async () =>
      new Response(new Uint8Array(0))) as unknown as typeof fetch;

    expect(await fetchBytes('https://cdn.example/empty.webp')).toBeNull();
  });

  it('returns null when the stream errors mid-body', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(16));
        controller.error(new Error('socket reset'));
      },
    });
    global.fetch = (async () => new Response(body)) as unknown as typeof fetch;

    expect(await fetchBytes('https://cdn.example/torn.webp')).toBeNull();
  });

  it('never opens a stream for a blocked host', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    expect(
      await fetchBytes('http://169.254.169.254/latest/meta-data'),
    ).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// Pins the SSRF blocklist alongside the cap — the two live in one module and a
// change to either is a change to what this fetcher may reach.
describe('isAllowedImageUrl', () => {
  it.each([
    'http://127.0.0.1/x.png',
    'http://localhost:9000/static/x.png',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.5/x.png',
    'http://192.168.1.1/x.png',
    'http://172.16.0.1/x.png',
    'http://[::1]/x.png',
    'http://[::ffff:127.0.0.1]/x.png',
    'file:///etc/passwd',
    'not a url',
  ])('blocks %s', (url) => {
    // S3_FILE_URL set ⇒ prod-shaped: the local-file-provider carve-out is off.
    const prior = process.env.S3_FILE_URL;
    process.env.S3_FILE_URL = 'https://cdn.example';
    try {
      expect(isAllowedImageUrl(url)).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.S3_FILE_URL;
      else process.env.S3_FILE_URL = prior;
    }
  });

  it.each(['https://cdn.example/card.webp', '/cdn/cards/card.webp'])(
    'allows %s',
    (url) => {
      expect(isAllowedImageUrl(url)).toBe(true);
    },
  );
});
