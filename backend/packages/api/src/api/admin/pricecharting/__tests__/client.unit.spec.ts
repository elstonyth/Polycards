import { pcFetch } from '../client';

const reply = (status: number, body: unknown) =>
  jest.spyOn(global, 'fetch').mockResolvedValue(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
    }),
  );

beforeEach(() => {
  process.env.PRICECHARTING_API_TOKEN = 'test-token';
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.PRICECHARTING_API_TOKEN;
});

it.each([
  [
    410,
    { status: 'error', 'error-message': 'Access token has expired' },
    'Access token has expired',
  ],
  [
    401,
    { status: 'error', 'error-message': 'Invalid access token' },
    'Invalid access token',
  ],
  [
    200,
    { status: 'error', 'error-message': 'Invalid access token' },
    'Invalid access token',
  ],
  [
    404,
    { status: 'error', 'error-message': 'Token not found' },
    'Token not found',
  ],
])(
  'HTTP %s %j is an auth failure, not a card error',
  async (status, body, message) => {
    reply(status, body);
    expect(await pcFetch('/api/product', { id: '1' })).toEqual({
      kind: 'error',
      message,
      cause: 'auth',
    });
  },
);

it.each([
  [503, 'Service Unavailable'],
  [502, { status: 'error', 'error-message': 'Bad gateway' }],
  [429, { status: 'error', 'error-message': 'Too many requests' }],
  [200, '<html>challenge</html>'],
  [401, 'Unauthorized'],
  [403, ''],
  [403, '<html>challenge</html>'],
  [503, { status: 'error', 'error-message': 'token service down' }],
  [429, { status: 'error', 'error-message': 'Too many token requests' }],
  [400, { status: 'error', 'error-message': 'Invalid API key' }],
  [410, { status: 'error', 'error-message': 'Product removed' }],
  [410, ''],
])('HTTP %s %j is the feed being unavailable', async (status, body) => {
  reply(status, body);
  expect(await pcFetch('/api/product', { id: '1' })).toMatchObject({
    kind: 'error',
    cause: 'unavailable',
  });
});

it('an unreadable 401/403/410 reply points at the API token', async () => {
  reply(403, '<html>challenge</html>');
  expect(await pcFetch('/api/product', { id: '1' })).toEqual({
    kind: 'error',
    message:
      'PriceCharting refused the request (HTTP 403); check PRICECHARTING_API_TOKEN',
    cause: 'unavailable',
  });
  reply(410, '');
  expect(await pcFetch('/api/product', { id: '1' })).toEqual({
    kind: 'error',
    message:
      'PriceCharting refused the request (HTTP 410); check PRICECHARTING_API_TOKEN',
    cause: 'unavailable',
  });
});

it('a readable 401/403/410 reply without a message points at the API token too', async () => {
  reply(403, { status: 'error' });
  expect(await pcFetch('/api/product', { id: '1' })).toEqual({
    kind: 'error',
    message:
      'PriceCharting refused the request (HTTP 403); check PRICECHARTING_API_TOKEN',
    cause: 'unavailable',
  });
});

it('an empty upstream message falls back to the status text', async () => {
  reply(503, { status: 'error', 'error-message': '' });
  expect(await pcFetch('/api/product', { id: '1' })).toEqual({
    kind: 'error',
    message: 'PriceCharting error (HTTP 503).',
    cause: 'unavailable',
  });
});

it('a JSON 404 without a message is a card-level error', async () => {
  reply(404, { status: 'error' });
  expect(await pcFetch('/api/product', { id: '1' })).toEqual({
    kind: 'error',
    message: 'PriceCharting error (HTTP 404).',
  });
});

it('a timeout is the feed being unavailable', async () => {
  jest.spyOn(global, 'fetch').mockRejectedValue(new Error('aborted'));
  expect(await pcFetch('/api/product', { id: '1' })).toEqual({
    kind: 'error',
    message: 'PriceCharting did not respond — try again.',
    cause: 'unavailable',
  });
});

it.each([404, 200])(
  'a card-level error (HTTP %s "No such product") carries no cause',
  async (status) => {
    reply(status, { status: 'error', 'error-message': 'No such product' });
    expect(await pcFetch('/api/product', { id: '1' })).toEqual({
      kind: 'error',
      message: 'No such product',
    });
  },
);

it('a 404 without a JSON body is the feed being unavailable', async () => {
  reply(404, '<html>Not Found</html>');
  expect(await pcFetch('/api/product', { id: '1' })).toEqual({
    kind: 'error',
    message: 'PriceCharting returned an unreadable response (HTTP 404).',
    cause: 'unavailable',
  });
});

it('no token never calls upstream', async () => {
  delete process.env.PRICECHARTING_API_TOKEN;
  const fetchSpy = jest.spyOn(global, 'fetch');
  expect(await pcFetch('/api/product', { id: '1' })).toEqual({
    kind: 'no-token',
  });
  expect(fetchSpy).not.toHaveBeenCalled();
});
