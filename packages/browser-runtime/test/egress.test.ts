import { expect, it } from 'vitest';
import {
  isPublicAddress,
  EgressPolicy,
  replSeccomp,
} from '../src/confinement.js';
it('denies metadata, private networks, IPv6 loopback and mapped addresses', () => {
  for (const address of [
    '127.0.0.1',
    '169.254.169.254',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '::1',
    '::',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ])
    expect(isPublicAddress(address), address).toBe(false);
  expect(isPublicAddress('8.8.8.8')).toBe(true);
  expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
});
it('requires an approved origin and explicit development port', async () => {
  const policy = new EgressPolicy([5173], async () => [
    { address: '8.8.8.8', family: 4 },
  ]);
  await expect(policy.destination('example.com', 443)).rejects.toThrow(
    /approved/,
  );
  policy.allow('https://example.com');
  expect((await policy.destination('example.com', 443)).address).toBe(
    '8.8.8.8',
  );
  policy.allow('http://localhost:5173');
  expect((await policy.destination('localhost', 5173))).toMatchObject({
    address: '127.0.0.1',
    addresses: ['127.0.0.1', '::1'],
  });
  await expect(policy.destination('localhost', 8788)).rejects.toThrow();
  expect(() => policy.allow('http://example.com:5173')).toThrow(/egress permits/);
});
it('generates an architecture-specific seccomp filter', () => {
  expect(replSeccomp('arm64').length).toBeGreaterThan(100);
  expect(replSeccomp('x64').length).toBeGreaterThan(100);
  expect(() => replSeccomp('riscv64')).toThrow();
});
it('revokes existing connections and rejects later destinations', async () => {
  const policy = new EgressPolicy([], async () => [
    { address: '8.8.8.8', family: 4 },
  ]);
  let closed = 0;
  policy.onRevoke(() => {
    closed++;
  });
  policy.allow('https://example.com');
  await policy.destination('example.com', 443);
  policy.revoke();
  expect(closed).toBe(1);
  await expect(policy.destination('example.com', 443)).rejects.toThrow(
    /approved/,
  );
});
