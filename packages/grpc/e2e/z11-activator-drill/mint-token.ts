#!/usr/bin/env bun
/**
 * `bun mint-token.ts --host <fn host> --issuer <iss> --key-dir <dir> --out <file>`
 *
 * Mints ONE valid zone token (the Z7 signer, method GetItem) for the function at <host> and writes
 * the `Bearer ...` header to <file> (mode 600). Prints nothing: the drill sends the token from a
 * foreign pod straight to a function pod's IP, which the host-side probe cannot reach. A token is
 * single-use, so every direct call mints its own.
 */
import { chmodSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { authorizationHeader } from '../z7-identity-kind/probe-lib';

const { values } = parseArgs({
  options: {
    host: { type: 'string' },
    issuer: { type: 'string' },
    'key-dir': { type: 'string' },
    out: { type: 'string' },
  },
  strict: true,
});
const host = values.host as string;
const parts = /^([^.]+)\.([^.]+)\.svc\.cluster\.local$/.exec(host ?? '');
if (!parts || !values.issuer || !values['key-dir'] || !values.out) {
  console.error(
    'mint-token: --host <svc.ns.svc.cluster.local> --issuer --key-dir --out are required',
  );
  process.exit(64);
}
const { header } = await authorizationHeader({
  mode: 'signer',
  keyDir: values['key-dir'],
  issuer: values.issuer,
  audience: `knext:fn:${parts[2]}/${parts[1]}`,
  method: '/example.v1.ExampleService/GetItem',
  sub: 'alice',
});
if (!header) {
  console.error('mint-token: no token was minted');
  process.exit(1);
}
writeFileSync(values.out, header, { mode: 0o600 });
chmodSync(values.out, 0o600);
