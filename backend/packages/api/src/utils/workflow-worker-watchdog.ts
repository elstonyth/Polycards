import { logger as frameworkLogger } from '@medusajs/framework/logger';
import { WorkflowScheduler } from '@medusajs/framework/orchestration';
import { alertOps } from '../modules/packs/ops-alert';
import {
  type BullWorker,
  replaceBullWorker,
  WORKER_ALERT_MUTE_MS,
} from './replace-bull-worker';

const CHECK_EVERY_MS = 60 * 1000;

type Logger = {
  error: (message: string) => void;
  warn: (message: string) => void;
  info: (message: string) => void;
};

// shortcut: private fields of @medusajs/workflow-engine-redis's storage and of
// bullmq's Worker, which an upgrade can rename (the spec pins them against the
// installed packages); drop this when Medusa restarts its own workers.
/** Each engine worker, and what stops while it is down. */
const WHAT_STOPS = {
  worker: 'workflow retries and timeouts were not running',
  jobWorker:
    'no scheduled job was running (deposit and withdrawal sweeps included)',
  cleanerWorker_: 'old workflow executions were not being cleared',
} as const;
type Field = keyof typeof WHAT_STOPS;
const WORKER_FIELDS = Object.keys(WHAT_STOPS) as Field[];
type WorkflowStorage = Partial<Record<Field, BullWorker>>;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Replaces any workflow-engine worker that has died.
 *
 * workflow-engine-redis builds three bull workers at boot: `jobWorker` runs
 * every scheduled job (the deposit sweeps, event-bus-watchdog), `worker` runs
 * workflow retries and timeouts, `cleanerWorker_` prunes old executions. If a
 * worker's first Redis connect fails it never runs again, even once Redis is
 * back; nothing restarts it and only a bare console.error marks it. Same fault
 * and same fix as the event bus consumer (event-bus-watchdog.ts): see
 * replaceBullWorker. Redis dropping under a running loop is a different case:
 * bullmq retries it and isRunning() stays true, so this leaves it alone.
 */
export function reviveWorkflowWorkers(storage: unknown, logger: Logger): void {
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
      const note = `The workflow engine's ${field} had stopped, so ${WHAT_STOPS[field]}. ${
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
        { muteMs: WORKER_ALERT_MUTE_MS },
      );
      if (ended) continue;

      replaceBullWorker(
        dead,
        dead.processFn,
        (fresh) => {
          workers[field] = fresh;
        },
        (stage, error) =>
          logger.error(
            stage === 'close'
              ? `[workflow-worker-watchdog] replaced the ${field}, but could not close the stopped one: ${message(error)}`
              : `[workflow-worker-watchdog] could not restart the ${field}: ${message(error)}`,
          ),
      );
    } catch (error) {
      logger.error(
        `[workflow-worker-watchdog] could not restart the ${field}: ${message(error)}`,
      );
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
