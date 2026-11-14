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
  [410, '', 'PriceCharting rejected the API token (HTTP 410).'],
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
])('HTTP %s %j is the feed being unavailable', async (status, body) => {
  reply(status, body);
  expect(await pcFetch('/api/product', { id: '1' })).toMatchObject({
    kind: 'error',
    cause: 'unavailable',
  });
});

it('an unreadable reply names its HTTP status', async () => {
  reply(403, '<html>challenge</html>');
  expect(await pcFetch('/api/product', { id: '1' })).toEqual({
    kind: 'error',
    message: 'PriceCharting returned an unreadable response (HTTP 403).',
    cause: 'unavailable',
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

it('a 404 without a JSON body is still card-level', async () => {
  reply(404, '<html>Not Found</html>');
  expect(await pcFetch('/api/product', { id: '1' })).toEqual({
    kind: 'error',
    message: 'PriceCharting error (HTTP 404).',
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
