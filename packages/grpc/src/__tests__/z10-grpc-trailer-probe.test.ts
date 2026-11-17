/**
 * The Z10 `grpctrailers` phase's client: a call over the gRPC protocol that
 * reports the `grpc-status` the wire carried (zone-caller/grpc-probe.ts).
 *
 * A real HTTP/2 server answers with a gRPC trailer (NotFound, OK) or with no
 * status at all. The probe must report the code and the raw trailer, and must
 * report NO status for a response that lost it: that is what the kind lane
 * fails closed on, so a probe that invented a status would make the lane
 * vacuous.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { createServer, type Http2Server, type ServerHttp2Stream } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { create, toBinary } from '@bufbuild/protobuf';
import { grpcProbe } from '../../e2e/z7-identity-kind/zone-caller/grpc-probe';
import {
  GetOrderResponseSchema,
  OrdersService,
} from '../../fixtures/zone/src/generated/grpc/orders/v1/orders_pb';

const servers: Http2Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

type Reply = 'ok' | 'notfound' | 'notfound-trailers-only';

function envelope(body: Uint8Array): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, Buffer.from(body)]);
}

async function serve(mode: Reply): Promise<{ url: string; saw: { contentType: string[] } }> {
  const saw = { contentType: [] as string[] };
  const server = createServer();
  server.on('stream', (stream: ServerHttp2Stream, headers) => {
    saw.contentType.push(String(headers['content-type']));
    stream.on('data', () => {});
    stream.on('end', () => {
      const msg = envelope(
        toBinary(GetOrderResponseSchema, create(GetOrderResponseSchema, { id: 'o-1' })),
      );
      const head = { ':status': 200, 'content-type': 'application/grpc+proto' };
      if (mode === 'notfound-trailers-only') {
        stream.respond(
          { ...head, 'grpc-status': '5', 'grpc-message': 'item not found' },
          { endStream: true },
        );
        return;
      }
      stream.respond(head, { waitForTrailers: true });
      stream.on('wantTrailers', () => {
        stream.sendTrailers(
          mode === 'notfound'
            ? { 'grpc-status': '5', 'grpc-message': 'item not found' }
            : { 'grpc-status': '0' },
        );
      });
      stream.end(mode === 'ok' ? msg : undefined);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, saw };
}

/** A server that answers with a message and ends the HTTP/2 stream: no status. */
async function statusless(): Promise<string> {
  const server = createServer();
  server.on('stream', (stream: ServerHttp2Stream) => {
    stream.on('data', () => {});
    stream.on('end', () => {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc+proto' });
      stream.end(
        envelope(toBinary(GetOrderResponseSchema, create(GetOrderResponseSchema, { id: 'o-1' }))),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const call = (baseUrl: string) =>
  grpcProbe({
    service: OrdersService,
    method: 'getOrder',
    baseUrl,
    input: { id: 'x' },
    timeoutMs: 5000,
  });

describe('the gRPC probe reports the status the wire carried', () => {
  it('a NotFound in the trailer is NotFound, with grpc-status 5', async () => {
    const s = await serve('notfound');
    expect(await call(s.url)).toEqual({
      protocol: 'grpc',
      ok: false,
      code: 'NotFound',
      grpcStatus: '5',
    });
    expect(s.saw.contentType[0]).toStartWith('application/grpc');
  });

  it('a trailers-only NotFound (the status in the headers) is the same', async () => {
    const s = await serve('notfound-trailers-only');
    expect(await call(s.url)).toEqual({
      protocol: 'grpc',
      ok: false,
      code: 'NotFound',
      grpcStatus: '5',
    });
  });

  it('a success carries grpc-status 0', async () => {
    const s = await serve('ok');
    expect(await call(s.url)).toEqual({ protocol: 'grpc', ok: true, code: 'OK', grpcStatus: '0' });
  });

  it('a response that lost its status reports NO grpc-status, and is not OK', async () => {
    const r = await call(await statusless());
    expect(r.grpcStatus).toBeNull();
    expect(r.ok).toBe(false);
    expect(r.code).not.toBe('NotFound');
  });
});
