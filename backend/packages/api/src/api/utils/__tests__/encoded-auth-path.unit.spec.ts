import { MedusaError } from '@medusajs/framework/utils';
import { refuseEncodedAuthPath } from '../encoded-auth-path';

// Both directions: an escape in the path must 404, and a plain path, including
// the Google callback whose QUERY carries escapes, must pass through untouched.

// `path` mimics what app.use leaves behind (the matched prefix stripped), so a
// guard that read req.path would see nothing to refuse.
const run = (originalUrl: string) => {
  const next = jest.fn();
  refuseEncodedAuthPath(
    { originalUrl, url: '/', path: '/' } as never,
    {} as never,
    next,
  );
  expect(next).toHaveBeenCalledTimes(1);
  return next.mock.calls[0][0] as unknown;
};

describe('refuseEncodedAuthPath', () => {
  it.each([
    '/auth/customer/%65mailpass',
    '/auth/%6Dember/emailpass',
    '/auth/user/emailpass/%72egister',
    '/auth/customer/emailpass/%75pdate',
    '/auth/%256Dember/emailpass',
  ])('404s %s', (path) => {
    const err = run(path);
    expect(err).toBeInstanceOf(MedusaError);
    expect((err as MedusaError).type).toBe(MedusaError.Types.NOT_FOUND);
  });

  it.each([
    '/auth/customer/emailpass',
    '/auth/user/emailpass/register',
    '/auth/token/refresh',
    // Only the pathname is checked, so the callback's escaped state/code
    // values in the query are not looked at.
    '/auth/customer/google/callback?code=4%2F0Ab&state=a%3Db',
  ])('passes %s through', (path) => {
    expect(run(path)).toBeUndefined();
  });
});
