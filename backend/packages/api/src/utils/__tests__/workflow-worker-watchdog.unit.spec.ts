jest.mock('../../modules/packs/ops-alert', () => ({
  alertOps: jest.fn().mockResolvedValue(undefined),
}));

import * as fs from 'fs';
import * as path from 'path';
import { WorkflowScheduler } from '@medusajs/framework/orchestration';
import { alertOps } from '../../modules/packs/ops-alert';
import {
  reviveWorkflowWorkers,
  startWorkflowWorkerWatchdog,
} from '../workflow-worker-watchdog';

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
    public processFn: unknown,
    public opts: Record<string, unknown>,
  ) {}
}

const FIELDS = ['worker', 'jobWorker', 'cleanerWorker_'] as const;
type Field = (typeof FIELDS)[number];
type Storage = Partial<Record<Field, FakeWorker>>;

const processor = async () => undefined;
// What bullmq leaves in worker.opts: its defaults merged in, autorun on, and
// the shared ioredis connection workflow-engine-redis built it with.
const opts = { autorun: true, concurrency: 1, connection: { shared: true } };

const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };

const storageWith = (make: (field: Field) => FakeWorker): Storage =>
  Object.fromEntries(FIELDS.map((field) => [field, make(field)]));

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('reviveWorkflowWorkers', () => {
  it('replaces each stopped worker with a fresh one on the same queue', async () => {
    const dead = storageWith((f) => new FakeWorker(`q-${f}`, processor, opts));
    const storage: Storage = { ...dead };

    reviveWorkflowWorkers(storage, logger);

    for (const field of FIELDS) {
      const fresh = storage[field]!;
      expect(fresh).not.toBe(dead[field]);
      expect(fresh).toBeInstanceOf(FakeWorker);
      expect(fresh.name).toBe(`q-${field}`);
      expect(fresh.processFn).toBe(processor);
      // autorun off, or bullmq's constructor starts the loop and the run()
      // below throws "Worker is already running".
      expect(fresh.opts).toEqual({ ...opts, autorun: false });
      expect(fresh.opts.connection).toBe(opts.connection);
      expect(fresh.run).toHaveBeenCalledTimes(1);
      // The dead one's RedisConnection keeps its rejected connect promise, so
      // run() on it again would only look like a revive.
      expect(dead[field]!.run).not.toHaveBeenCalled();
      expect(dead[field]!.close).toHaveBeenCalledWith(true);
    }
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[workflow-worker-watchdog]'),
    );
    for (const field of FIELDS) {
      expect(alertOps).toHaveBeenCalledWith(
        expect.anything(),
        `workflow-worker-stopped:${field}`,
        expect.stringContaining(field),
        { muteMs: 30 * 60 * 1000 },
      );
    }
  });

  // Through the real alertOps and its mute window: all three die together, and
  // the scheduled-job alert must not be swallowed by the first one.
  it('alerts for every stopped worker, the scheduled-job one included', () => {
    const real = jest.requireActual<
      typeof import('../../modules/packs/ops-alert')
    >('../../modules/packs/ops-alert');
    real.resetOpsAlerts();
    jest.mocked(alertOps).mockImplementation(real.alertOps);
    const storage = storageWith(
      (f) => new FakeWorker(`q-${f}`, processor, opts),
    );

    reviveWorkflowWorkers(storage, logger);

    const opsLines = logger.error.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith('[ops-alert]'));
    expect(opsLines).toHaveLength(3);
    expect(opsLines).toContainEqual(
      expect.stringContaining(
        "[ops-alert] workflow-worker-stopped:jobWorker: The workflow engine's jobWorker had stopped, so no scheduled job was running",
      ),
    );
    real.resetOpsAlerts();
  });

  // ioredis 'end': closed for good, so a new Worker on it could never connect.
  it('does not churn workers on a shared connection that has ended', () => {
    const ended = { ...opts, connection: { status: 'end' } };
    const dead = new FakeWorker('q-jobs', processor, ended);
    const storage: Storage = { jobWorker: dead };

    reviveWorkflowWorkers(storage, logger);
    reviveWorkflowWorkers(storage, logger);

    expect(storage.jobWorker).toBe(dead);
    expect(dead.close).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('restart the worker component'),
    );
    expect(alertOps).toHaveBeenCalledWith(
      expect.anything(),
      'workflow-worker-stopped:jobWorker',
      expect.stringContaining('restart the worker component'),
      { muteMs: 30 * 60 * 1000 },
    );
  });

  it('leaves running workers alone, so no second loop starts', () => {
    const live = storageWith((f) => {
      const w = new FakeWorker(`q-${f}`, processor, opts);
      w.running = true;
      return w;
    });
    const storage: Storage = { ...live };

    reviveWorkflowWorkers(storage, logger);

    for (const field of FIELDS) {
      expect(storage[field]).toBe(live[field]);
      expect(live[field]!.run).not.toHaveBeenCalled();
      expect(live[field]!.close).not.toHaveBeenCalled();
    }
    expect(logger.error).not.toHaveBeenCalled();
    expect(alertOps).not.toHaveBeenCalled();
  });

  it('replaces only the worker that stopped', () => {
    const storage = storageWith((f) => {
      const w = new FakeWorker(`q-${f}`, processor, opts);
      w.running = f !== 'jobWorker';
      return w;
    });
    const before = { ...storage };

    reviveWorkflowWorkers(storage, logger);

    expect(storage.worker).toBe(before.worker);
    expect(storage.cleanerWorker_).toBe(before.cleanerWorker_);
    expect(storage.jobWorker).not.toBe(before.jobWorker);
  });

  // A graceful shutdown stops the loops on purpose.
  it('leaves workers alone while they are shutting down', () => {
    const storage = storageWith((f) => {
      const w = new FakeWorker(`q-${f}`, processor, opts);
      w.closing = Promise.resolve();
      return w;
    });
    const before = { ...storage };

    reviveWorkflowWorkers(storage, logger);

    expect(storage).toEqual(before);
    expect(alertOps).not.toHaveBeenCalled();
  });

  // Server mode builds no workers, the in-memory engine has none, and the
  // timer starts before the workflow module has set its storage.
  it.each([
    ['no storage yet', undefined],
    ['server mode', {}],
    ['the in-memory engine', { storage_: new Map() }],
  ])('does nothing with %s', (_label, storage) => {
    expect(() => reviveWorkflowWorkers(storage, logger)).not.toThrow();
    expect(logger.error).not.toHaveBeenCalled();
    expect(alertOps).not.toHaveBeenCalled();
  });

  it('survives a fresh worker that also fails, and tries again next tick', async () => {
    const failing = jest
      .fn()
      .mockRejectedValue(new Error('Connection is closed.'));
    class StillDown extends FakeWorker {
      run = failing;
    }
    const storage: Storage = {
      jobWorker: new StillDown('q-jobs', processor, opts),
    };

    reviveWorkflowWorkers(storage, logger);
    await flush();

    const first = storage.jobWorker!;
    expect(failing).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Connection is closed.'),
    );

    reviveWorkflowWorkers(storage, logger);
    expect(storage.jobWorker).not.toBe(first);
    expect(first.close).toHaveBeenCalledWith(true);
  });

  it('keeps the old worker when a new one cannot be built', () => {
    const dead = new FakeWorker('q-jobs', processor, opts);
    Object.defineProperty(dead, 'constructor', {
      value: class {
        constructor() {
          throw new Error('Worker requires a connection');
        }
      },
    });
    const storage: Storage = { jobWorker: dead };

    expect(() => reviveWorkflowWorkers(storage, logger)).not.toThrow();

    expect(storage.jobWorker).toBe(dead);
    // Kept open: the next tick needs it to build another replacement from.
    expect(dead.close).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Worker requires a connection'),
    );
  });

  it('does not throw when closing the dead worker rejects', async () => {
    const dead = new FakeWorker('q-jobs', processor, opts);
    dead.close.mockRejectedValue(new Error('close failed'));
    const storage: Storage = { jobWorker: dead };

    reviveWorkflowWorkers(storage, logger);
    await flush();

    expect(storage.jobWorker!.run).toHaveBeenCalledTimes(1);
    // The restart worked, so the log must not say it failed: the ops checks
    // count "could not restart" as a fault.
    expect(logger.error).toHaveBeenCalledWith(
      '[workflow-worker-watchdog] replaced the jobWorker, but could not close the stopped one: close failed',
    );
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.stringContaining('could not restart'),
    );
  });
});

describe('startWorkflowWorkerWatchdog', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('checks the scheduler storage every minute without holding the process open', () => {
    jest.useFakeTimers();
    const dead = new FakeWorker('q-jobs', processor, opts);
    const storage: Storage = { jobWorker: dead };
    const scheduler = WorkflowScheduler as unknown as { storage?: unknown };
    const saved = scheduler.storage;
    scheduler.storage = storage;
    try {
      const timer = startWorkflowWorkerWatchdog(logger);
      expect(timer.hasRef()).toBe(false);

      jest.advanceTimersByTime(59_999);
      expect(storage.jobWorker).toBe(dead);
      jest.advanceTimersByTime(1);
      expect(storage.jobWorker).not.toBe(dead);

      clearInterval(timer);
    } finally {
      scheduler.storage = saved;
    }
  });
});

describe('instrumentation register()', () => {
  const load = () =>
    require('../../../instrumentation') as typeof import('../../../instrumentation');

  const savedMode = process.env.MEDUSA_WORKER_MODE;
  afterEach(() => {
    if (savedMode === undefined) delete process.env.MEDUSA_WORKER_MODE;
    else process.env.MEDUSA_WORKER_MODE = savedMode;
  });

  it.each(['worker', 'shared', undefined])(
    'starts the watchdog in mode %s',
    (mode) => {
      if (mode === undefined) delete process.env.MEDUSA_WORKER_MODE;
      else process.env.MEDUSA_WORKER_MODE = mode;
      jest.isolateModules(() => {
        const start = jest.fn();
        jest.doMock('../workflow-worker-watchdog', () => ({
          startWorkflowWorkerWatchdog: start,
        }));
        load().register();
        expect(start).toHaveBeenCalledTimes(1);
      });
    },
  );

  // The web service has no workflow workers to watch.
  it('does not start on the web service', () => {
    process.env.MEDUSA_WORKER_MODE = 'server';
    jest.isolateModules(() => {
      const start = jest.fn();
      jest.doMock('../workflow-worker-watchdog', () => ({
        startWorkflowWorkerWatchdog: start,
      }));
      load().register();
      expect(start).not.toHaveBeenCalled();
    });
  });

  // Medusa calls register() outside its boot error handling: a throw here
  // would stop the web service and the worker from starting at all.
  it('lets boot go on when the watchdog fails to load', () => {
    process.env.MEDUSA_WORKER_MODE = 'worker';
    jest.isolateModules(() => {
      jest.doMock('../workflow-worker-watchdog', () => {
        throw new Error('load failed');
      });
      const error = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      try {
        expect(() => load().register()).not.toThrow();
        expect(error).toHaveBeenCalledWith(
          '[workflow-worker-watchdog] not started: load failed',
        );
      } finally {
        error.mockRestore();
      }
    });
  });
});

// The watchdog reads private fields of two packages. A rename would look like
// "no workers": a silent no-op. An upgrade must fail here instead.
describe('installed packages still match', () => {
  const engineDir = path.dirname(
    require.resolve('@medusajs/workflow-engine-redis/package.json'),
  );
  const read = (file: string) => fs.readFileSync(file, 'utf8');

  it('workflow-engine-redis builds its workers on these fields', () => {
    const storage = read(
      path.join(engineDir, 'dist/utils/workflow-orchestrator-storage.js'),
    );
    expect(storage).toContain('this.worker = new bullmq_1.Worker(');
    expect(storage).toContain('this.jobWorker = new bullmq_1.Worker(');
    expect(storage).toContain('this.cleanerWorker_ = new bullmq_1.Worker(');
    // Shutdown closes whatever sits on the fields, so a fresh worker gets closed.
    expect(storage).toContain('await this.jobWorker?.close();');
    const orchestrator = read(
      path.join(engineDir, 'dist/services/workflow-orchestrator.js'),
    );
    expect(orchestrator).toContain(
      'orchestration_1.WorkflowScheduler.setStorage(redisDistributedTransactionStorage);',
    );
  });

  it('the bullmq it loads keeps a function processor on processFn', () => {
    const worker = read(
      require.resolve('bullmq/dist/cjs/classes/worker.js', {
        paths: [engineDir],
      }),
    );
    expect(worker).toContain('this.processFn = processor;');
    expect(worker).toContain('if (this.opts.autorun) {');
  });
});
