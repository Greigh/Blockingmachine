import { ApiError } from '../api/client';
import { describeError, describeActionError, UserError } from '../errors';

describe('describeError', () => {
  it('maps unreachable to plain language with the technical detail kept', () => {
    const { title, detail } = describeError(
      new ApiError('unreachable', 'Network request failed'),
    );
    expect(title).toMatch(/same network/i);
    expect(title).not.toMatch(/network request failed/i);
    expect(detail).toBe('Network request failed');
  });

  it('maps unauthorized to the token remedy', () => {
    const { title } = describeError(new ApiError('unauthorized', 'HTTP 401', 401));
    expect(title).toMatch(/feed token/i);
  });

  it('prefers a human server message over a generic title', () => {
    const { title, detail } = describeError(
      new ApiError('server', 'DNS daemon is not running', 503),
    );
    expect(title).toBe('DNS daemon is not running');
    expect(detail).toBe('Error 503');
  });

  it('passes UserError messages through verbatim', () => {
    const { title } = describeError(new UserError('VPN access was declined.'));
    expect(title).toBe('VPN access was declined.');
  });

  it('generic errors get a plain title and technical detail', () => {
    const { title, detail } = describeError(new Error('IllegalStateException: no react context'));
    expect(title).toMatch(/something went wrong/i);
    expect(detail).toBe('IllegalStateException: no react context');
  });
});

describe('describeActionError', () => {
  it('prefixes the action context', () => {
    const { title } = describeActionError(
      'Couldn\u2019t compile rules',
      new ApiError('unreachable', 'x'),
    );
    expect(title).toMatch(/^Couldn\u2019t compile rules:/);
  });
});
