import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { SandboxInputError } from '../../../utils/automation-sandbox-engine';
import {
  changeSandbox,
  readSandbox,
} from '../../../utils/automation-sandbox-store';

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  res.json(await readSandbox(req.scope));
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  try {
    res.json(
      await changeSandbox(req.scope, req.body, req.auth_context.actor_id),
    );
  } catch (error) {
    if (!(error instanceof SandboxInputError)) throw error;
    res.status(error.status).json({ message: error.message });
  }
}
