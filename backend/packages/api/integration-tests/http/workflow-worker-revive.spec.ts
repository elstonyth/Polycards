// Real-Redis proof for src/utils/workflow-worker-watchdog.ts: the INSTALLED
// workflow-engine-redis storage and bullmq, booted the way the worker component
// boots them, against a live Redis.
//
// The fault (2026-10-31, on the event bus): Redis refuses or times out a new
// connection while the module boots. The shared ioredis clients are already
// connected, but each bull Worker opens its own blocking connection, and when
// that first connect fails bullmq keeps the rejected promise: the worker never
// runs again, even after Redis is back. A TCP proxy in front of Redis
// reproduces it: while "down" it drops new connections and keeps open ones.
//
// Deliberately FAILS (no silent skip) when Redis is unreachable, like the
// rate-limit suites: CI's redis service runs it.
import * as net from 'net';
import Redis from 'ioredis';
import { RedisDistributedTransactionStorage } from '@medusajs/workflow-engine-redis/dist/utils';
import { reviveWorkflowWorkers } from '../../src/utils/workflow-worker-watchdog';
import { connectTestRedisOrFail, TEST_REDIS_URL } from './test-redis';

jest.setTimeout(60 * 1000);

const FIELDS = ['worker', 'jobWorker', 'cleanerWorker_'] as const;

type BullWorker = {
  isRunning(): boolean;
  closing?: Promise<void>;
  run(): Promise<void>;
};
type Storage = Record<(typeof FIELDS)[number], BullWorker> & {
  jobQueue: { getWorkers(): Promise<unknown[]> };
  executeScheduledJob: (jobId: string) => Promise<void>;
  onApplicationStart(): Promise<void>;
  onApplicationPrepareShutdown(): Promise<void>;
  onApplicationShutdown(): Promise<void>;
  schedule(jobId: string, options: { interval: number }): Promise<void>;
};

const until = async (check: () => boolean, ms = 15_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

/** Pipes to Redis; while down, drops each new connection and keeps open ones. */
async function startProxy(target: URL) {
  let up = true;
  const open = new Set<net.Socket>();
  const server = net.createServer((client) => {
    client.on('error', () => undefined);
    if (!up) {
      client.destroy();
      return;
    }
    const upstream = net.connect(Number(target.port || 6379), target.hostname);
    upstream.on('error', () => undefined);
    for (const socket of [client, upstream]) {
      open.add(socket);
      socket.on('close', () => {
        open.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(target.href);
  url.hostname = '127.0.0.1';
  url.port = String((server.address() as net.AddressInfo).port);
  return {
    url: url.href,
    setUp: (value: boolean) => {
      up = value;
    },
    close: async () => {
      for (const socket of open) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const RUN = Date.now().toString(36);
let proxy: Awaited<ReturnType<typeof startProxy>>;
let direct: Redis;
const booted: Array<{ storage: Storage; clients: Redis[]; prefix: string }> =
  [];
const logger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

/** Builds the storage as workflow-engine-redis's loader and module do. */
async function bootStorage(
  name: string,
  { redisDown }: { redisDown: boolean },
) {
  const prefix = `test-wf-revive-${RUN}-${name}`;
  // The loader's getConnection: lazyConnect, which the Workers' duplicates
  // inherit, so their first connect is an explicit connect() that can reject.
  const connect = async (extra: object = {}) => {
    const client = new Redis(proxy.url, { lazyConnect: true, ...extra });
    client.on('error', () => undefined);
    await client.connect();
    return client;
  };
  const connection = await connect();
  const workerConnection = await connect({ maxRetriesPerRequest: null });
  const opts = { prefix };
  const storage = new RedisDistributedTransactionStorage({
    workflowExecutionService: { delete: async () => undefined },
    redisConnection: connection,
    redisWorkerConnection: workerConnection,
    redisQueueName: 'medusa-workflows',
    redisJobQueueName: 'medusa-workflows-jobs',
    redisMainQueueOptions: opts,
    redisMainWorkerOptions: opts,
    redisJobQueueOptions: opts,
    redisJobWorkerOptions: opts,
    redisCleanerQueueOptions: opts,
    redisCleanerWorkerOptions: opts,
    logger,
    isWorkerMode: true,
  } as never) as unknown as Storage;
  const fired = jest.fn();
  // Stands in for running the job's workflow: the proof is that the worker
  // picked the scheduled job up at all.
  storage.executeScheduledJob = async (jobId) => {
    fired(jobId);
  };
  booted.push({ storage, clients: [connection, workerConnection], prefix });

  proxy.setUp(!redisDown);
  try {
    await storage.onApplicationStart();
    if (redisDown) {
      await until(() => FIELDS.every((f) => !storage[f].isRunning()));
    }
  } finally {
    proxy.setUp(true);
  }
  return { storage, fired, workerConnection };
}

beforeAll(async () => {
  direct = await connectTestRedisOrFail(
    'this suite proves the workflow worker revive against real Redis',
  );
  proxy = await startProxy(new URL(TEST_REDIS_URL));
});

afterAll(async () => {
  for (const { storage, clients, prefix } of booted) {
    await storage.onApplicationPrepareShutdown().catch(() => undefined);
    await storage.onApplicationShutdown().catch(() => undefined);
    for (const client of clients) client.disconnect();
    const keys = await direct.keys(`${prefix}:*`);
    if (keys.length) await direct.del(...keys);
  }
  await proxy?.close();
  direct?.disconnect();
});

beforeEach(() => {
  jest.clearAllMocks();
});

it('revives workers whose first connect failed at boot, and the scheduled job fires', async () => {
  const { storage, fired, workerConnection } = await bootStorage('dead', {
    redisDown: true,
  });

  // Redis is back and the job is due every 300 ms, yet nothing runs it: the
  // workers stay dead on their own. This is the production fault.
  await storage.schedule('probe-job', { interval: 300 });
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(fired).not.toHaveBeenCalled();
  for (const field of FIELDS) expect(storage[field].isRunning()).toBe(false);

  const dead = Object.fromEntries(FIELDS.map((f) => [f, storage[f]]));
  reviveWorkflowWorkers(storage, logger);

  for (const field of FIELDS) {
    expect(storage[field]).not.toBe(dead[field]);
    expect(storage[field].isRunning()).toBe(true);
    // Closing the dead one leaves the engine's shared connection up.
    await dead[field].closing;
  }
  expect(workerConnection.status).toBe('ready');

  await until(() => fired.mock.calls.length > 0);
  expect(fired).toHaveBeenCalledWith('probe-job');
  expect(logger.error).toHaveBeenCalledWith(
    expect.stringContaining(
      "[workflow-worker-watchdog] The workflow engine's jobWorker had stopped",
    ),
  );
  // One loop per queue: the fresh worker ran once, never "already running".
  expect(logger.error).not.toHaveBeenCalledWith(
    expect.stringContaining('could not restart'),
  );
  expect(await storage.jobQueue.getWorkers()).toHaveLength(1);
});

it('leaves healthy workers alone, with no second loop', async () => {
  const { storage, fired } = await bootStorage('healthy', { redisDown: false });
  await until(() => FIELDS.every((f) => storage[f].isRunning()));
  const live = Object.fromEntries(FIELDS.map((f) => [f, storage[f]]));
  // A spy on bullmq's shared prototype: restored even if an assertion fails, so
  // it cannot leak into later suites in the same CI shard.
  const run = jest.spyOn(Object.getPrototypeOf(storage.jobWorker), 'run');
  try {
    reviveWorkflowWorkers(storage, logger);
    reviveWorkflowWorkers(storage, logger);

    for (const field of FIELDS) expect(storage[field]).toBe(live[field]);
    expect(run).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(await storage.jobQueue.getWorkers()).toHaveLength(1);
  } finally {
    run.mockRestore();
  }

  await storage.schedule('probe-job', { interval: 300 });
  await until(() => fired.mock.calls.length > 0);
});
