import { describe, expect, test } from 'vitest';
import {
  isSetupRequiredResponse,
  isSignedOutResponse,
  signInInstead,
} from './login-redirect';

const BACKEND = 'https://admin.polycards.gg';
const deliveries = {
  href: 'https://admin.polycards.gg/dashboard/deliveries',
  pathname: '/dashboard/deliveries',
};

describe('isSignedOutResponse', () => {
  test('a 401 from the admin API means signed out', () => {
    expect(
      isSignedOutResponse(`${BACKEND}/admin/media`, 401, BACKEND, deliveries),
    ).toBe(true);
    // Same-origin relative URL (an empty __BACKEND_URL__).
    expect(
      isSignedOutResponse('/admin/delivery-orders/x', 401, '', deliveries),
    ).toBe(true);
  });

  test('a missing permission (403) and other statuses stay on the page', () => {
    for (const status of [200, 400, 403, 404, 500]) {
      expect(
        isSignedOutResponse(
          `${BACKEND}/admin/media`,
          status,
          BACKEND,
          deliveries,
        ),
      ).toBe(false);
    }
  });

  test('a wrong password on the login page is not a redirect loop', () => {
    const login = {
      href: 'https://admin.polycards.gg/dashboard/login',
      pathname: '/dashboard/login',
    };
    expect(
      isSignedOutResponse(`${BACKEND}/admin/users/me`, 401, BACKEND, login),
    ).toBe(false);
    expect(
      isSignedOutResponse(
        `${BACKEND}/auth/user/emailpass`,
        401,
        BACKEND,
        deliveries,
      ),
    ).toBe(false);
  });

  test("Mercur's own session probe is left to Mercur, which keeps the page", () => {
    expect(
      isSignedOutResponse(`${BACKEND}/admin/users/me`, 401, BACKEND, deliveries),
    ).toBe(false);
  });

  test('a 401 from anywhere else is not ours to act on', () => {
    expect(
      isSignedOutResponse(
        'https://cdn.example.com/admin/x.png',
        401,
        BACKEND,
        deliveries,
      ),
    ).toBe(false);
    expect(
      isSignedOutResponse(`${BACKEND}/store/credits`, 401, BACKEND, deliveries),
    ).toBe(false);
  });
});

describe('isSetupRequiredResponse', () => {
  const setup = {
    href: 'https://admin.polycards.gg/dashboard/two-step-setup',
    pathname: '/dashboard/two-step-setup',
  };

  test('sends a login with no authenticator to its setup', () => {
    expect(
      isSetupRequiredResponse(
        `${BACKEND}/admin/users/me`,
        403,
        'mfa_setup_required',
        BACKEND,
        deliveries,
      ),
    ).toBe(true);
  });

  test('leaves a missing permission, and the setup page itself, alone', () => {
    expect(
      isSetupRequiredResponse(
        `${BACKEND}/admin/players`,
        403,
        'not_allowed',
        BACKEND,
        deliveries,
      ),
    ).toBe(false);
    expect(
      isSetupRequiredResponse(
        `${BACKEND}/admin/users/me`,
        403,
        'mfa_setup_required',
        BACKEND,
        setup,
      ),
    ).toBe(false);
  });
});

describe('signInInstead', () => {
  test("replaces the dashboard's login page, keeping the query", () => {
    expect(signInInstead('/dashboard/login', '?reason=Unauthorized', '/dashboard/')).toBe(
      '/dashboard/sign-in?reason=Unauthorized',
    );
    expect(signInInstead('/dashboard/login/', '', '/dashboard')).toBe(
      '/dashboard/sign-in',
    );
  });

  test('leaves every other page', () => {
    expect(signInInstead('/dashboard/sign-in', '', '/dashboard')).toBeNull();
    expect(signInInstead('/dashboard/players/login', '', '/dashboard')).toBeNull();
  });
});
