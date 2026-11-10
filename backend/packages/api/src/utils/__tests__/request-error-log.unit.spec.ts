import { MedusaError } from '@medusajs/framework/utils';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { loggableRequestId, requestErrorLog } from '../request-error-log';

const call = (err: unknown, requestId: unknown = 'req-123') => {
  const logger = { error: jest.fn(), info: jest.fn(), warn: jest.fn() };
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  const req = {
    method: 'POST',
    path: '/store/packs/x/open',
    requestId,
    scope: {
      resolve: (key: string) => {
        if (key === ContainerRegistrationKeys.LOGGER) return logger;
        throw new Error(`unexpected resolve(${key})`);
      },
    },
  };
  requestErrorLog(err, req as never, res as never, jest.fn());
  const ours = logger.error.mock.calls
    .map((c) => c[0])
    .filter(
      (m): m is string => typeof m === 'string' && m.startsWith('request_id='),
    );
  return { res, ours };
};

describe('requestErrorLog', () => {
  it('logs the request id beside a 500, after the stock answer', () => {
    const { res, ours } = call(new Error('pool timeout'));
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ type: 'unknown_error' });
    expect(ours).toEqual([
      'request_id=req-123 POST /store/packs/x/open -> 500: pool timeout',
    ]);
  });

  it('adds nothing for a caller error', () => {
    const { res, ours } = call(
      new MedusaError(MedusaError.Types.INVALID_DATA, 'bad amount'),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ message: 'bad amount' });
    expect(ours).toEqual([]);
  });

  it('does not let a client-sent id forge log lines', () => {
    const { ours } = call(new Error('x'), 'abc\n{"level":"info"} fake');
    expect(ours[0]).toMatch(/^request_id=abclevel:infofake POST/);
  });
});

describe('loggableRequestId', () => {
  it.each([
    [undefined, '-'],
    ['', '-'],
    ['\n\n', '-'],
    ['a'.repeat(100), 'a'.repeat(64)],
    ['3f2c-11ef:ab.cd_9', '3f2c-11ef:ab.cd_9'],
  ])('%p -> %p', (input, expected) => {
    expect(loggableRequestId(input)).toBe(expected);
  });
});
