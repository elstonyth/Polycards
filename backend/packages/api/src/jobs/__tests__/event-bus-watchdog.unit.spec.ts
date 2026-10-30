jest.mock('../../modules/packs/ops-alert', () => ({
  alertOps: jest.fn().mockResolvedValue(undefined),
}));

import * as fs from 'fs';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import LocalEventBusService from '@medusajs/event-bus-local/dist/services/event-bus-local';
import { alertOps } from '../../modules/packs/ops-alert';
import eventBusWatchdogJob, { config } from '../event-bus-watchdog';

class FakeWorker {
  closing?: Promise<void>;
  running = false;
  isRunning = () => this.running;
  run = jest.fn(async () => {
    this.running = true;
  });
  close = jest.fn(async () => undefined);
  constructor(
    public name: string,
    public processor: unknown,
    public opts: unknown,
  ) {}
}

const processor = async () => undefined;
const opts = { prefix: 'RedisEventBusService', autorun: false };

const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };

const setup = (dead: FakeWorker) => {
  const bus = { bullWorker_: dead, worker_: processor };
  const container = {
    resolve: (key: string) =>
      key === ContainerRegistrationKeys.LOGGER ? logger : bus,
  };
  return {
    bus,
    run: () => eventBusWatchdogJob(container as never),
  };
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('event-bus-watchdog', () => {
  it('replaces a stopped consumer with a fresh worker on the same queue', async () => {
    const dead = new FakeWorker('events-queue', processor, opts);
    const { bus, run } = setup(dead);

    await run();

    const fresh = bus.bullWorker_;
    expect(fresh).not.toBe(dead);
    expect(fresh).toBeInstanceOf(FakeWorker);
    expect(fresh.name).toBe('events-queue');
    expect(fresh.processor).toBe(processor);
    expect(fresh.opts).toBe(opts);
    expect(fresh.run).toHaveBeenCalledTimes(1);
    // A stopped bullmq Worker rejects run() forever: its RedisConnection keeps
    // the rejected connect promise. Calling it again would look like a revive.
    expect(dead.run).not.toHaveBeenCalled();
    expect(dead.close).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[event-bus-watchdog]'),
    );
    expect(alertOps).toHaveBeenCalledWith(
      expect.anything(),
      'event-bus-consumer-stopped',
      expect.any(String),
      { muteMs: 30 * 60 * 1000 },
    );
  });

  it('leaves a running consumer alone, so no second loop starts', async () => {
    const live = new FakeWorker('events-queue', processor, opts);
    live.running = true;
    const { bus, run } = setup(live);

    await run();

    expect(bus.bullWorker_).toBe(live);
    expect(live.run).not.toHaveBeenCalled();
    expect(live.close).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(alertOps).not.toHaveBeenCalled();
  });

  // The loop also stops, on purpose, when a graceful shutdown closes the worker.
  it('leaves a consumer alone while it is shutting down', async () => {
    const closing = new FakeWorker('events-queue', processor, opts);
    closing.closing = Promise.resolve();
    const { bus, run } = setup(closing);

    await run();

    expect(bus.bullWorker_).toBe(closing);
    expect(closing.run).not.toHaveBeenCalled();
    expect(alertOps).not.toHaveBeenCalled();
  });

  it('does nothing on the in-memory bus', async () => {
    const localBus = new LocalEventBusService(
      { logger } as never,
      {},
      {} as never,
    );
    const container = {
      resolve: (key: string) =>
        key === ContainerRegistrationKeys.LOGGER ? logger : localBus,
    };

    await expect(
      eventBusWatchdogJob(container as never),
    ).resolves.toBeUndefined();

    expect(logger.error).not.toHaveBeenCalled();
    expect(alertOps).not.toHaveBeenCalled();
  });

  it('survives a fresh worker that also fails, and tries again next run', async () => {
    const dead = new FakeWorker('events-queue', processor, opts);
    const { bus, run } = setup(dead);
    // Redis is still down: the replacement's run() rejects as well.
    const failing = jest
      .fn()
      .mockRejectedValue(new Error('Connection is closed.'));
    Object.defineProperty(dead, 'constructor', {
      value: class extends FakeWorker {
        run = failing;
      },
    });
    await expect(run()).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));

    const first = bus.bullWorker_;
    expect(first).not.toBe(dead);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Connection is closed.'),
    );

    // The next run replaces the failed one and releases its connection.
    await run();
    expect(bus.bullWorker_).not.toBe(first);
    expect(first.close).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the worker cannot be built, and keeps the old one', async () => {
    const dead = new FakeWorker('events-queue', processor, opts);
    const { bus, run } = setup(dead);
    Object.defineProperty(dead, 'constructor', {
      value: class {
        constructor() {
          throw new Error('Worker requires a connection');
        }
      },
    });

    await expect(run()).resolves.toBeUndefined();

    expect(bus.bullWorker_).toBe(dead);
    // Kept open: the next run needs it to build another replacement from.
    expect(dead.close).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Worker requires a connection'),
    );
  });

  it('does not throw when closing the dead worker rejects', async () => {
    const dead = new FakeWorker('events-queue', processor, opts);
    dead.close.mockRejectedValue(new Error('close failed'));
    const { bus, run } = setup(dead);

    await expect(run()).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));

    expect(bus.bullWorker_.run).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('close failed'),
    );
  });

  it('does not throw when the bus cannot be resolved', async () => {
    const container = {
      resolve: (key: string) => {
        if (key === ContainerRegistrationKeys.LOGGER) return logger;
        throw new Error(`no ${key}`);
      },
    };

    await expect(
      eventBusWatchdogJob(container as never),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(`no ${Modules.EVENT_BUS}`),
    );
  });

  // The job reads two private fields, and a renamed bullWorker_ would look exactly
  // like the in-memory bus: a silent no-op. A Medusa upgrade must fail here instead.
  it('still matches the private fields of the installed event-bus-redis', () => {
    const source = fs.readFileSync(
      require.resolve(
        '@medusajs/event-bus-redis/dist/services/event-bus-redis.js',
      ),
      'utf8',
    );
    expect(source).toContain('this.bullWorker_ = new bullmq_1.Worker(');
    expect(source).toContain('this.worker_ = async');
    expect(source).toContain('this.bullWorker_?.close()');
  });

  it('runs every minute', () => {
    expect(config).toEqual({ name: 'event-bus-watchdog', schedule: '* * * * *' });
  });
});
