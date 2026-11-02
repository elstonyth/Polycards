import { ADMIN_SESSION_MAX_MS, capAdminSessionAge } from '../admin-session-cap';

const run = (session: Record<string, unknown> | undefined, now: number) => {
  const destroy = jest.fn((cb: () => void) => cb());
  const json = jest.fn();
  const res = { status: jest.fn(() => ({ json })) };
  const next = jest.fn();
  const req = { session: session && { ...session, destroy } };
  capAdminSessionAge(req as any, res as any, next, now);
  return { req, res, json, next, destroy };
};

describe('capAdminSessionAge', () => {
  it('stamps a signed-in session on its first request and lets it through', () => {
    const { req, next } = run({ auth_context: { actor_id: 'user_1' } }, 1_000);
    expect(next).toHaveBeenCalled();
    expect((req.session as any).started_at).toBe(1_000);
  });

  it('keeps a session younger than the cap, however often it is renewed', () => {
    const { next, destroy } = run(
      { auth_context: {}, started_at: 0 },
      ADMIN_SESSION_MAX_MS,
    );
    expect(next).toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it('ends a session older than the cap with the framework 401', () => {
    const { next, destroy, res, json } = run(
      { auth_context: {}, started_at: 0 },
      ADMIN_SESSION_MAX_MS + 1,
    );
    expect(next).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ message: 'Unauthorized' });
  });

  it('leaves signed-out and bearer requests to the framework', () => {
    expect(run(undefined, 1).next).toHaveBeenCalled();
    const anon = run({}, 1);
    expect(anon.next).toHaveBeenCalled();
    expect((anon.req.session as any).started_at).toBeUndefined();
  });
});
