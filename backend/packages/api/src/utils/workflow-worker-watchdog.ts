import { logger as frameworkLogger } from '@medusajs/framework/logger';
import { WorkflowScheduler } from '@medusajs/framework/orchestration';
import { alertOps } from '../modules/packs/ops-alert';

const CHECK_EVERY_MS = 60 * 1000;
/** Redis can stay down for a while, and the check runs every minute. */
const ALERT_MUTE_MS = 30 * 60 * 1000;

type Logger = {
  error: (message: string) => void;
  warn: (message: string) => void;
  info: (message: string) => void;
};

type BullWorker = {
  name: string;
  opts: Record<string, unknown>;
  processFn?: unknown;
  closing?: unknown;
  isRunning(): boolean;
  run(): Promise<void>;
  close(force?: boolean): Promise<void>;
};

// shortcut: private fields of @medusajs/workflow-engine-redis's storage and of
// bullmq's Worker, which an upgrade can rename (the spec pins them against the
// installed packages); drop this when Medusa restarts its own workers.
const WORKER_FIELDS = ['worker', 'jobWorker', 'cleanerWorker_'] as const;
type WorkflowStorage = Partial<
  Record<(typeof WORKER_FIELDS)[number], BullWorker>
>;

/**
 * Replaces any workflow-engine worker that has died.
 *
 * workflow-engine-redis builds three bull workers at boot: `jobWorker` runs
 * every scheduled job (the deposit sweeps, event-bus-watchdog), `worker` runs
 * workflow retries and timeouts, `cleanerWorker_` prunes old executions. If a
 * worker's first Redis connect fails, bullmq's RedisConnection keeps the
 * rejected connect promise and the worker never runs again, even once Redis is
 * back; nothing restarts it and only a bare console.error marks it. Same fault
 * and same fix as the event bus consumer (event-bus-watchdog.ts): a new Worker
 * from the dead one's class, queue, processor and options. Redis dropping under
 * a running loop is a different case: bullmq retries it and isRunning() stays
 * true, so this leaves it alone.
 */
export function reviveWorkflowWorkers(storage: unknown, logger: Logger): void {
  const logFailure = (error: unknown) => {
    logger.error(
      `[workflow-worker-watchdog] could not restart a workflow worker: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  };
  const workers = (storage ?? {}) as WorkflowStorage;
  for (const field of WORKER_FIELDS) {
    try {
      const dead = workers[field];
      // None: server mode or the in-memory engine. `closing`: a graceful
      // shutdown stopped it on purpose. Running: there must never be a second loop.
      if (!dead || dead.isRunning() || dead.closing) continue;

      // The engine's shared connection closed for good: every new Worker would
      // fail on it, so replacing would only churn. Restarting the process fixes it.
      const ended =
        (dead.opts.connection as { status?: string } | undefined)?.status ===
        'end';
      const note = `The workflow engine's ${field} had stopped, so ${
        field === 'jobWorker'
          ? 'no scheduled job was running (deposit and withdrawal sweeps included)'
          : field === 'worker'
            ? 'workflow retries and timeouts were not running'
            : 'old workflow executions were not being cleared'
      }. ${
        ended
          ? 'Its Redis connection is closed for good, so it cannot be replaced in place: restart the worker component.'
          : 'Starting a new one. Repeats mean Redis is still unreachable.'
      }`;
      logger.error(`[workflow-worker-watchdog] ${note}`);
      // One tag per worker: they die together, and one shared mute window would
      // let the first worker's alert swallow the scheduled-job one.
      void alertOps(
        { resolve: <T>() => logger as T },
        `workflow-worker-stopped:${field}`,
        note,
        { muteMs: ALERT_MUTE_MS },
      );
      if (ended) continue;

      // dead.constructor is bullmq's Worker, the exact version the engine loads.
      const Worker = dead.constructor as new (
        name: string,
        processor: unknown,
        opts: unknown,
      ) => BullWorker;
      // autorun off: the engine left it on, and the constructor would start a
      // loop of its own that run() below then throws on.
      const fresh = new Worker(dead.name, dead.processFn, {
        ...dead.opts,
        autorun: false,
      });
      // Installed first, so the engine's shutdown hook closes this one.
      workers[field] = fresh;
      // force: the dead worker never took a job. isRunning() only goes false when
      // run() throws before its fetch loop starts; inside the loop bullmq retries
      // every fetch and process call instead of throwing. Closing releases its
      // reconnecting Redis client and stops its timers.
      void dead.close(true).catch(logFailure);
      void fresh.run().catch(logFailure);
    } catch (error) {
      logFailure(error);
    }
  }
}

/**
 * Checks the workflow-engine workers every minute, for the life of the process.
 * Started from instrumentation.ts, not a scheduled job: a scheduled job runs on
 * jobWorker, the worker this has to watch.
 */
export function startWorkflowWorkerWatchdog(
  logger: Logger = frameworkLogger,
): NodeJS.Timeout {
  // WorkflowScheduler is a process global; the engine sets its storage at load.
  const scheduler = WorkflowScheduler as unknown as { storage?: unknown };
  const timer = setInterval(
    () => reviveWorkflowWorkers(scheduler.storage, logger),
    CHECK_EVERY_MS,
  );
  // Never what keeps a process alive, or a shutdown would wait on it.
  timer.unref();
  logger.info(
    '[workflow-worker-watchdog] checking the workflow engine workers every minute',
  );
  return timer;
}
