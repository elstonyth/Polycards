/** The part of bullmq's Worker the worker watchdogs read and call. */
export type BullWorker = {
  name: string;
  opts: Record<string, unknown>;
  processFn?: unknown;
  closing?: unknown;
  isRunning(): boolean;
  run(): Promise<void>;
  close(force?: boolean): Promise<void>;
};

/** Redis can stay down for a while, and the watchdogs check every minute. */
export const WORKER_ALERT_MUTE_MS = 30 * 60 * 1000;

/**
 * Swaps a bull worker whose loop has stopped for a new one on the same queue,
 * shared by event-bus-watchdog.ts and workflow-worker-watchdog.ts.
 *
 * A new Worker, because calling run() again cannot work: if a Worker's first
 * Redis connect fails, bullmq's RedisConnection keeps the rejected connect
 * promise and that Worker rejects forever, even after Redis is back.
 *
 * Throws only when the new Worker cannot be built, before anything changed, so
 * the caller still holds the dead one to try again from. The close and run that
 * follow are not awaited (the money sweeps must not wait on them); their
 * failures go to `onError`.
 */
export function replaceBullWorker(
  dead: BullWorker,
  processor: unknown,
  install: (fresh: BullWorker) => void,
  onError: (stage: 'close' | 'run', error: unknown) => void,
): void {
  // dead.constructor is bullmq's Worker, the exact version its module loads:
  // bullmq is not a dependency of this package.
  const Worker = dead.constructor as new (
    name: string,
    processor: unknown,
    opts: unknown,
  ) => BullWorker;
  // dead.opts carries the queue prefix and shared connection it was built with.
  // autorun off: left on, the constructor would start a loop of its own that
  // run() below then throws on.
  const fresh = new Worker(dead.name, processor, {
    ...dead.opts,
    autorun: false,
  });
  // Installed first, so the module's shutdown hook closes this one.
  install(fresh);
  // force: the dead worker never took a job. isRunning() only goes false when
  // run() throws before its fetch loop starts; inside the loop bullmq retries
  // every fetch and process call instead of throwing. Closing releases its
  // reconnecting Redis client and stops its timers.
  void dead.close(true).catch((error: unknown) => onError('close', error));
  void fresh.run().catch((error: unknown) => onError('run', error));
}
