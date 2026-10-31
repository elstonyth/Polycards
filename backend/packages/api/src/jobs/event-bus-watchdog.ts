import type { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { alertOps } from '../modules/packs/ops-alert';

/** Redis can stay down for a while, and this job runs every minute. */
const ALERT_MUTE_MS = 30 * 60 * 1000;

type BullWorker = {
  name: string;
  opts: unknown;
  closing?: unknown;
  isRunning(): boolean;
  run(): Promise<void>;
  close(force?: boolean): Promise<void>;
};

// shortcut: reads private fields of @medusajs/event-bus-redis, which an upgrade can
// rename (this job's spec pins them against the installed module), drop it when
// Medusa restarts its own consumer or exposes a health check.
type RedisEventBus = {
  bullWorker_?: BullWorker;
  worker_?: unknown;
};

/**
 * Replaces the event bus consumer when it has died.
 *
 * event-bus-redis starts its bull worker once at boot and only logs if run()
 * rejects, which it does when the worker's first Redis connect fails. Nothing
 * starts it again, so signup stamps, password-reset emails and pull posts stop
 * silently until the next deploy (seen 2026-10-31 04:55 MYT). The events wait in
 * Redis, and a new consumer drains them.
 *
 * A new Worker, because calling run() again cannot work: bullmq's RedisConnection
 * keeps the rejected connect promise, so that Worker rejects forever, even after
 * ioredis has reconnected. Redis dropping once the loop is running is a different
 * case: bullmq retries it and isRunning() stays true, so this job leaves it alone.
 * Not a process restart, which would also cut across the money sweeps on this
 * component.
 *
 * It can only watch this one worker. The job itself is run by a bull worker inside
 * workflow-engine-redis, built the same way: if that one dies at boot, no scheduled
 * job runs, this one included.
 */
export default async function eventBusWatchdogJob(
  container: MedusaContainer,
): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const logFailure = (error: unknown) => {
    logger.error(
      `[event-bus-watchdog] could not restart the consumer: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  };
  try {
    const bus = container.resolve<RedisEventBus>(Modules.EVENT_BUS);
    const dead = bus.bullWorker_;
    // No bull worker: the in-memory bus. `closing`: a graceful shutdown stopped
    // the loop on purpose. Running: run() on it would throw, and there must never
    // be a second loop.
    if (!dead || dead.isRunning() || dead.closing) return;

    const note =
      'The event bus consumer had stopped, so signup stamps, password-reset emails and pull posts were not going out. Starting a new one; waiting events will drain. Repeats mean Redis is still unreachable.';
    logger.error(`[event-bus-watchdog] ${note}`);
    void alertOps(container, 'event-bus-consumer-stopped', note, {
      muteMs: ALERT_MUTE_MS,
    });

    // dead.opts carries the queue prefix and shared connection Medusa built it with.
    // dead.constructor is bullmq's Worker, the exact version the module loads:
    // bullmq is not a dependency of this package.
    const Worker = dead.constructor as new (
      name: string,
      processor: unknown,
      opts: unknown,
    ) => BullWorker;
    const fresh = new Worker(dead.name, bus.worker_, dead.opts);
    // Installed first, so the module's shutdown hook closes this one.
    bus.bullWorker_ = fresh;
    // Neither is awaited: this job must not hold up the money sweeps, and force
    // skips waiting on jobs the dead worker never took. Closing releases its
    // reconnecting Redis client and stops its timers.
    void dead.close(true).catch(logFailure);
    void fresh.run().catch(logFailure);
  } catch (error) {
    logFailure(error);
  }
}

export const config = {
  name: 'event-bus-watchdog',
  schedule: '* * * * *',
};
