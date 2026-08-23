import { refuseCrossOriginAdminWrite } from '../admin-origin-guard';

// The contract is a gate, and it can fail in two directions. Too permissive
// re-opens the admin-CSRF surface this guard backstops; too strict bricks the
// operator dashboard, which is the failure mode that gets a security control
// deleted rather than fixed. Both directions are asserted below.

const ADMIN_CORS = 'https://admin.polycards.gg,http://localhost:7000';

const call = (req: { method: string; headers?: Record<string, unknown> }) => {
  const next = jest.fn();
  let thrown: unknown;
  try {
    refuseCrossOriginAdminWrite(
      { headers: {}, ...req } as never,
      {} as never,
      next,
    );
  } catch (error) {
    thrown = error;
  }
  return { next, thrown };
};

describe('refuseCrossOriginAdminWrite', () => {
  const original = process.env.ADMIN_CORS;
  beforeEach(() => {
    process.env.ADMIN_CORS = ADMIN_CORS;
  });
  afterAll(() => {
    if (original === undefined) delete process.env.ADMIN_CORS;
    else process.env.ADMIN_CORS = original;
  });

  it('refuses a state-changing request from a foreign origin', () => {
    const { next, thrown } = call({
      method: 'POST',
      headers: { origin: 'https://attacker.example' },
    });

    expect(next).not.toHaveBeenCalled();
    expect((thrown as Error).message).toBe(
      'Cross-origin admin request refused.',
    );
  });

  it('does not echo the refused origin back to the caller', () => {
    const { thrown } = call({
      method: 'POST',
      headers: { origin: 'https://attacker.example' },
    });

    expect((thrown as Error).message).not.toContain('attacker.example');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'refuses %s, not just POST',
    (method) => {
      const { next, thrown } = call({
        method,
        headers: { origin: 'https://attacker.example' },
      });

      expect(next).not.toHaveBeenCalled();
      expect(thrown).toBeDefined();
    },
  );

  it('allows an allowlisted origin', () => {
    const { next, thrown } = call({
      method: 'POST',
      headers: { origin: 'https://admin.polycards.gg' },
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(thrown).toBeUndefined();
  });

  it('allows an allowlisted origin written with a trailing slash', () => {
    // An operator pasting into the DO console will eventually add one, on
    // either side of the comparison.
    const { next } = call({
      method: 'POST',
      headers: { origin: 'https://admin.polycards.gg/' },
    });

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows the dev dashboard origin', () => {
    const { next } = call({
      method: 'POST',
      headers: { origin: 'http://localhost:7000' },
    });

    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])(
    'lets %s through even from a foreign origin',
    (method) => {
      // OPTIONS especially: it must reach the cors middleware to be answered,
      // and none of the three changes state.
      const { next, thrown } = call({
        method,
        headers: { origin: 'https://attacker.example' },
      });

      expect(next).toHaveBeenCalledTimes(1);
      expect(thrown).toBeUndefined();
    },
  );

  it('allows a request with no Origin header (non-browser client)', () => {
    // curl / CI / scripts send no Origin and hold no ambient cookie. A browser
    // always sends Origin on a non-GET, so no forged form post lands here.
    const { next } = call({ method: 'POST' });

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows an empty Origin header', () => {
    const { next } = call({ method: 'POST', headers: { origin: '' } });

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('fails OPEN when ADMIN_CORS is unset', () => {
    // Deliberate: this is the second layer behind sameSite:'lax'. An empty
    // allowlist refusing every admin write would brick the panel on a missing
    // env var — worse than quietly not guarding, when the braces still hold.
    delete process.env.ADMIN_CORS;
    const { next, thrown } = call({
      method: 'POST',
      headers: { origin: 'https://attacker.example' },
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(thrown).toBeUndefined();
  });

  it('reads ADMIN_CORS per request, not at import', () => {
    // plan-066 convention: one booted app must be drivable through both states.
    process.env.ADMIN_CORS = 'https://other.example';
    expect(
      call({ method: 'POST', headers: { origin: 'https://other.example' } })
        .next,
    ).toHaveBeenCalledTimes(1);
    expect(
      call({
        method: 'POST',
        headers: { origin: 'https://admin.polycards.gg' },
      }).next,
    ).not.toHaveBeenCalled();
  });
});
