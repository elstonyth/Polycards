import type { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import {
  advanceSandbox,
  applySandboxAction,
  createSandboxState,
  sandboxSnapshot,
} from './automation-sandbox-engine';
import type { SandboxSnapshot, SandboxState } from './automation-sandbox-types';

type Row = { state: unknown };
interface Connection {
  raw(sql: string, bindings?: unknown[]): Promise<{ rows: Row[] }>;
}
interface Database extends Connection {
  transaction<T>(callback: (transaction: Connection) => Promise<T>): Promise<T>;
}

function decode(value: unknown): SandboxState {
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('mode' in value) ||
    value.mode !== 'sandbox'
  )
    throw new Error('Unsupported sandbox state version.');
  return value as SandboxState;
}

export async function readSandbox(
  container: MedusaContainer,
): Promise<SandboxSnapshot> {
  const db = container.resolve<Database>(
    ContainerRegistrationKeys.PG_CONNECTION,
  );
  const { rows } = await db.raw(
    `select state from automation_sandbox where id = 'global' and deleted_at is null`,
  );
  return sandboxSnapshot(
    rows.length ? decode(rows[0].state) : createSandboxState(Date.now()),
  );
}

export async function changeSandbox(
  container: MedusaContainer,
  action: unknown,
  actorId: string,
  now = Date.now(),
): Promise<SandboxSnapshot> {
  const db = container.resolve<Database>(
    ContainerRegistrationKeys.PG_CONNECTION,
  );
  return db.transaction(async (transaction) => {
    await transaction.raw(`set local lock_timeout = '5s'`);
    await transaction.raw(
      `insert into automation_sandbox (id, state, updated_by) values ('global', ?::jsonb, ?) on conflict (id) do nothing`,
      [JSON.stringify(createSandboxState(now)), actorId],
    );
    const { rows } = await transaction.raw(
      `select state from automation_sandbox where id = 'global' and deleted_at is null for update`,
    );
    if (rows.length !== 1) throw new Error('Sandbox workspace unavailable.');
    const state = applySandboxAction(decode(rows[0].state), action, now);
    await transaction.raw(
      `update automation_sandbox set state = ?::jsonb, updated_by = ?, updated_at = now() where id = 'global'`,
      [JSON.stringify(state), actorId],
    );
    return sandboxSnapshot(state);
  });
}

export async function tickSandbox(
  container: MedusaContainer,
  now = Date.now(),
): Promise<boolean> {
  const db = container.resolve<Database>(
    ContainerRegistrationKeys.PG_CONNECTION,
  );
  return db.transaction(async (transaction) => {
    // The scheduler can deliver concurrent jobs. This lock also serializes Stop and all edits.
    const { rows } = await transaction.raw(
      `select state from automation_sandbox where id = 'global' and deleted_at is null
      and state->>'status' = 'running' and coalesce((state->>'nextRunAt')::bigint, 0) <= ? for update skip locked`,
      [now],
    );
    if (!rows.length) return false;
    let state = decode(rows[0].state);
    const before = structuredClone(state);
    try {
      if (!advanceSandbox(state, now)) return false;
    } catch (error) {
      // A failed cycle commits no partial ledger changes and cannot retry indefinitely.
      state = {
        ...before,
        status: 'failed',
        nextRunAt: null,
        finishedAt: now,
        error: error instanceof Error ? error.message : 'Sandbox cycle failed.',
      };
    }
    await transaction.raw(
      `update automation_sandbox set state = ?::jsonb, updated_at = now() where id = 'global'`,
      [JSON.stringify(state)],
    );
    return true;
  });
}
