import { describe, it, expect } from 'vitest';
import {
  ValetError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
  RateLimitError,
  IntegrationError,
  ErrorCodes,
  isAuthFailureCode,
  shouldClearAuthOn401,
} from './errors.js';

describe('ErrorCodes', () => {
  it('has expected constants', () => {
    expect(ErrorCodes.NOT_FOUND).toBe('NOT_FOUND');
    expect(ErrorCodes.UNAUTHORIZED).toBe('UNAUTHORIZED');
    expect(ErrorCodes.FORBIDDEN).toBe('FORBIDDEN');
    expect(ErrorCodes.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
    expect(ErrorCodes.RATE_LIMIT_EXCEEDED).toBe('RATE_LIMIT_EXCEEDED');
    expect(ErrorCodes.INTEGRATION_AUTH_FAILED).toBe('INTEGRATION_AUTH_FAILED');
    expect(ErrorCodes.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
  });
});

describe('ValetError', () => {
  it('constructs with message, code, statusCode, details', () => {
    const err = new ValetError('something broke', ErrorCodes.INTERNAL_ERROR, 500, { foo: 1 });
    expect(err.message).toBe('something broke');
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(err.statusCode).toBe(500);
    expect(err.details).toEqual({ foo: 1 });
    expect(err.name).toBe('ValetError');
  });

  it('defaults statusCode to 500', () => {
    const err = new ValetError('err', ErrorCodes.INTERNAL_ERROR);
    expect(err.statusCode).toBe(500);
  });

  it('toJSON returns error, code, details', () => {
    const err = new ValetError('msg', ErrorCodes.INTERNAL_ERROR, 500, { x: 1 });
    expect(err.toJSON()).toEqual({
      error: 'msg',
      code: 'INTERNAL_ERROR',
      details: { x: 1 },
    });
  });

  it('is instanceof Error', () => {
    const err = new ValetError('msg', ErrorCodes.INTERNAL_ERROR);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ValetError);
  });
});

describe('NotFoundError', () => {
  it('sets 404 status and NOT_FOUND code', () => {
    const err = new NotFoundError('Session');
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('Session not found');
  });

  it('includes id in message when provided', () => {
    const err = new NotFoundError('Session', 'abc-123');
    expect(err.message).toBe("Session with id 'abc-123' not found");
  });

  it('instanceof chain: NotFoundError → ValetError → Error', () => {
    const err = new NotFoundError('X');
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toBeInstanceOf(ValetError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('UnauthorizedError', () => {
  it('sets 401 status and UNAUTHORIZED code', () => {
    const err = new UnauthorizedError();
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.message).toBe('Unauthorized');
  });

  it('accepts custom message', () => {
    const err = new UnauthorizedError('Token expired');
    expect(err.message).toBe('Token expired');
  });

  it('accepts a custom auth-failure code', () => {
    const err = new UnauthorizedError('Bad token', ErrorCodes.AUTH_INVALID);
    expect(err.code).toBe('AUTH_INVALID');
    expect(err.statusCode).toBe(401);
  });

  it('instanceof chain', () => {
    const err = new UnauthorizedError();
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err).toBeInstanceOf(ValetError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('isAuthFailureCode', () => {
  it('matches auth-tier codes emitted by the auth middleware', () => {
    expect(isAuthFailureCode('AUTH_MISSING')).toBe(true);
    expect(isAuthFailureCode('AUTH_INVALID')).toBe(true);
  });

  it('does NOT match the generic UNAUTHORIZED default', () => {
    // A route handler throwing `new UnauthorizedError()` without an explicit
    // code is expressing a route-level authorization failure — it must not
    // wipe the user's login. Route-level auth denials should use
    // ForbiddenError (403) instead.
    expect(isAuthFailureCode('UNAUTHORIZED')).toBe(false);
  });

  it('rejects resource-level 401 codes and unknown values', () => {
    expect(isAuthFailureCode('FORBIDDEN')).toBe(false);
    expect(isAuthFailureCode('SESSION_NOT_FOUND')).toBe(false);
    expect(isAuthFailureCode(undefined)).toBe(false);
    expect(isAuthFailureCode('')).toBe(false);
  });
});

describe('shouldClearAuthOn401', () => {
  it('clears on auth-tier codes from the middleware regardless of body shape', () => {
    expect(shouldClearAuthOn401({ code: 'AUTH_MISSING', hasJsonBody: true })).toBe(true);
    expect(shouldClearAuthOn401({ code: 'AUTH_INVALID', hasJsonBody: true })).toBe(true);
    // Auth-tier code but no JSON body — still clears; the code is the
    // authoritative signal.
    expect(shouldClearAuthOn401({ code: 'AUTH_MISSING', hasJsonBody: false })).toBe(true);
    expect(shouldClearAuthOn401({ code: 'AUTH_INVALID', hasJsonBody: false })).toBe(true);
  });

  it('clears on bare 401s from a Valet JSON response with no code field', () => {
    // The app itself answered (JSON body) but didn't set a code — treat
    // as identity failure and force re-auth.
    expect(shouldClearAuthOn401({ code: undefined, hasJsonBody: true })).toBe(true);
    expect(shouldClearAuthOn401({ code: '', hasJsonBody: true })).toBe(true);
  });

  it('does NOT clear when the body was non-JSON (intermediary 401)', () => {
    // A Cloudflare WAF interstitial or a text/plain "Unauthorized" from
    // a proxy has no JSON body. We can't attribute the 401 to Valet, so
    // we leave auth state alone.
    expect(shouldClearAuthOn401({ code: undefined, hasJsonBody: false })).toBe(false);
    expect(shouldClearAuthOn401({ code: '', hasJsonBody: false })).toBe(false);
  });

  it('does NOT clear on explicit UNAUTHORIZED (route-level authz denial)', () => {
    expect(shouldClearAuthOn401({ code: 'UNAUTHORIZED', hasJsonBody: true })).toBe(false);
    expect(shouldClearAuthOn401({ code: 'UNAUTHORIZED', hasJsonBody: false })).toBe(false);
  });

  it('does NOT clear on unrelated resource errors', () => {
    expect(shouldClearAuthOn401({ code: 'FORBIDDEN', hasJsonBody: true })).toBe(false);
    expect(shouldClearAuthOn401({ code: 'SESSION_NOT_FOUND', hasJsonBody: true })).toBe(false);
    expect(shouldClearAuthOn401({ code: 'VALIDATION_ERROR', hasJsonBody: true })).toBe(false);
    expect(shouldClearAuthOn401({ code: 'FORBIDDEN', hasJsonBody: false })).toBe(false);
  });
});

describe('ForbiddenError', () => {
  it('sets 403 status and FORBIDDEN code', () => {
    const err = new ForbiddenError();
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
    expect(err.message).toBe('Forbidden');
  });

  it('accepts custom message', () => {
    const err = new ForbiddenError('Admin only');
    expect(err.message).toBe('Admin only');
  });
});

describe('ValidationError', () => {
  it('sets 400 status and VALIDATION_ERROR code', () => {
    const err = new ValidationError('Invalid input');
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('Invalid input');
  });

  it('includes details', () => {
    const details = { field: 'email', issue: 'required' };
    const err = new ValidationError('Validation failed', details);
    expect(err.details).toEqual(details);
    expect(err.toJSON().details).toEqual(details);
  });
});

describe('RateLimitError', () => {
  it('sets 429 status and RATE_LIMIT_EXCEEDED code', () => {
    const err = new RateLimitError();
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(err.message).toBe('Rate limit exceeded');
  });

  it('includes retryAfter in details', () => {
    const err = new RateLimitError(30);
    expect(err.details).toEqual({ retryAfter: 30 });
  });
});

describe('IntegrationError', () => {
  it('sets 400 status with default INTEGRATION_AUTH_FAILED code', () => {
    const err = new IntegrationError('GitHub auth failed');
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('INTEGRATION_AUTH_FAILED');
    expect(err.message).toBe('GitHub auth failed');
  });

  it('accepts custom code', () => {
    const err = new IntegrationError('Sync failed', ErrorCodes.SYNC_FAILED);
    expect(err.code).toBe('SYNC_FAILED');
  });

  it('accepts details', () => {
    const err = new IntegrationError('Error', ErrorCodes.INTEGRATION_AUTH_FAILED, { provider: 'slack' });
    expect(err.details).toEqual({ provider: 'slack' });
  });
});
