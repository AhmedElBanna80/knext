// A call to a function over the gRPC protocol (HTTP/2), reporting the status the
// wire carried. Used by the e2e zone's /example/grpc route (the Z10 `grpctrailers`
// phase), never by a real zone: the generated glue speaks Connect over h2c.
//
// The call goes through createGrpcTransport, whose client takes its error code
// from the `grpc-status` trailer (or the header, for a trailers-only response).
// A proxy on the cold path that drops the trailer therefore cannot be told apart
// from a server that never sent one, and the client fails the call; this probe
// reports the raw `grpc-status` it saw next to the code the client derived, so
// the lane can require both and require them to agree.

import type { DescService } from '@bufbuild/protobuf';
import { Code, ConnectError, createClient, type Interceptor } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';

export interface GrpcProbeResult {
  /** Always 'grpc': the probe never speaks Connect. */
  readonly protocol: 'grpc';
  readonly ok: boolean;
  /** The client's code, by name ('OK' for a success). */
  readonly code: string;
  /** The raw `grpc-status` the wire carried, or null when none arrived. */
  readonly grpcStatus: string | null;
}

export interface GrpcProbeOptions {
  readonly service: DescService;
  /** The method's local name, as on the client: 'getItem', 'putItem'. */
  readonly method: string;
  readonly baseUrl: string;
  readonly headers?: Record<string, string>;
  readonly input: Record<string, unknown>;
  readonly timeoutMs?: number;
}

export async function grpcProbe(opts: GrpcProbeOptions): Promise<GrpcProbeResult> {
  let seen: string | null = null;
  // Reads the status off the response (success) before the client turns it into
  // an error (failure: the ConnectError's metadata is the trailer it was read from).
  const watch: Interceptor = (next) => async (req) => {
    try {
      const res = await next(req);
      seen = res.trailer.get('grpc-status') ?? res.header.get('grpc-status');
      return res;
    } catch (err) {
      seen = ConnectError.from(err).metadata.get('grpc-status');
      throw err;
    }
  };
  const transport = createGrpcTransport({
    baseUrl: opts.baseUrl,
    httpVersion: '2',
    interceptors: [watch],
  });
  const client = createClient(opts.service, transport) as unknown as Record<
    string,
    (
      input: unknown,
      o: { headers?: Record<string, string>; timeoutMs?: number },
    ) => Promise<unknown>
  >;
  const call = client[opts.method];
  if (!call) throw new Error(`${opts.service.typeName} has no method ${opts.method}`);
  try {
    await call(opts.input, { headers: opts.headers, timeoutMs: opts.timeoutMs ?? 30_000 });
    return { protocol: 'grpc', ok: true, code: 'OK', grpcStatus: seen };
  } catch (err) {
    const e = ConnectError.from(err);
    return { protocol: 'grpc', ok: false, code: Code[e.code] ?? String(e.code), grpcStatus: seen };
  }
}
