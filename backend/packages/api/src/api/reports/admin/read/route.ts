import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import {
  ContainerRegistrationKeys,
  generateJwtToken,
} from '@medusajs/framework/utils';
import {
  adminPathError,
  blockedReason,
  capBody,
  DESK_BOT_ACTOR,
  deskBotRoleId,
  redact,
} from '../proxy';

// GET /reports/admin/read?path=/admin/<screen>&<filters>: what an admin
// dashboard screen's API answers, read-only, for the desk bots (proxy.ts has
// the rules). Every query parameter other than `path` is passed on as the
// screen's own filters (limit, offset, fields, q, ...).
//
// It mints a 60-second token for DESK_BOT_ACTOR carrying only the read-only
// role and calls this same server's admin API on localhost, so the request
// runs through the real admin stack (auth, RBAC, validators) and the
// credential never leaves the process.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const path = req.query.path;
  const bad = adminPathError(path);
  if (bad) {
    res.status(400).json({ message: bad });
    return;
  }
  const target = path as string;
  const blocked = blockedReason(target);
  if (blocked) {
    res.status(403).json({
      message: `That screen (${blocked}) is not open to the desk bots.`,
    });
    return;
  }

  const filters = new URLSearchParams();
  for (const [name, value] of Object.entries(req.query)) {
    if (name === 'path') continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      if (typeof v === 'string') filters.append(name, v);
    }
  }

  const { http } = req.scope.resolve(
    ContainerRegistrationKeys.CONFIG_MODULE,
  ).projectConfig;
  const token = generateJwtToken(
    {
      actor_id: DESK_BOT_ACTOR,
      actor_type: 'user',
      auth_identity_id: '',
      app_metadata: {
        user_id: DESK_BOT_ACTOR,
        roles: [await deskBotRoleId(req.scope)],
      },
    },
    { secret: http.jwtSecret, expiresIn: 60, jwtOptions: http.jwtOptions },
  );
  // The port this request arrived on is the port this server listens on.
  const port = req.socket.localPort;
  const query = filters.toString();
  let answer: Response;
  try {
    answer = await fetch(
      `http://127.0.0.1:${port}${target}${query ? `?${query}` : ''}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    res.status(504).json({ message: 'The admin API did not answer in time.' });
    return;
  }
  if (
    !(answer.headers.get('content-type') ?? '').includes('application/json')
  ) {
    res.status(415).json({
      message:
        'That admin path does not answer JSON (a file or a page): desk bots read JSON screens only.',
    });
    return;
  }
  const body = (await answer.json().catch(() => null)) as {
    message?: string;
  } | null;
  if (!answer.ok) {
    res.status(answer.status).json({
      message: body?.message ?? `The admin API answered ${answer.status}.`,
    });
    return;
  }
  res.json(capBody(redact(body)));
}
