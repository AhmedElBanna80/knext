// Package rpc wires the function: the connect-go v2 server with its
// interceptors (OTel, panic recovery, the token check), the gRPC health
// service, and an HTTP server that speaks HTTP/2 cleartext (h2c) and
// HTTP/1.1 on one port.
package rpc

import (
	"context"
	"errors"
	"iter"
	"log/slog"
	"net"
	"net/http"
	"time"

	"connectrpc.com/connect/v2"
	"connectrpc.com/connect/v2/connecthttp"
	"connectrpc.com/grpchealth/v2"
	"connectrpc.com/otelconnect"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"example.com/function/gen/example/v1/examplev1connect"
	"example.com/function/internal/auth"
	"example.com/function/internal/items"
)

// MaxRequestBytes bounds one request message, both as sent and after it is
// decompressed.
const MaxRequestBytes = 4 << 20

// MaxRequestBodyBytes bounds a whole request body as read off the wire: one
// message at MaxRequestBytes plus its framing. The server stops reading a
// longer body there instead of draining it.
const MaxRequestBodyBytes = MaxRequestBytes + 64<<10

// The HTTP server's timeouts. ReadTimeout cuts off a request body that stops
// arriving; it bounds only the body, over h2c and HTTP/1.1 alike (net/http
// lifts the read deadline once the body is read), so a call may run longer.
const (
	ReadHeaderTimeout = 10 * time.Second
	ReadTimeout       = 30 * time.Second
	IdleTimeout       = 120 * time.Second
)

// ShutdownGrace is how long in-flight calls get to finish after SIGTERM.
const ShutdownGrace = 25 * time.Second

// Config is the function's runtime configuration.
type Config struct {
	// Addr is the listen address, ":8080" when empty.
	Addr string
	// JWKSPath is the mounted JWKS file the token check reads.
	JWKSPath string
	// Issuer and Audience are what every token must name: the owning zone
	// and this function. With either empty, every RPC but the health check
	// is refused.
	Issuer, Audience string
	// SeenCapacity is how many accepted tokens the token check remembers to
	// refuse a replay; zero is auth.DefaultSeenCapacity (see its comment before
	// changing it).
	SeenCapacity int
	// Now is the token check's clock; it defaults to time.Now (tests set it).
	Now func() time.Time
	// Logger defaults to slog.Default().
	Logger *slog.Logger
	// TracerProvider defaults to the global OTel provider.
	TracerProvider trace.TracerProvider
}

// Function is the assembled server.
type Function struct {
	HTTP   *http.Server
	rpc    *connect.Server
	logger *slog.Logger
	// mux is the handler inside the body cap; tests mount probes on it.
	mux *http.ServeMux
}

// New assembles the function with the token check reading the JWKS mounted
// at cfg.JWKSPath and holding tokens to cfg.Issuer and cfg.Audience, with each
// RPC's auth option read from the compiled contract. This is the only
// constructor the binary uses.
func New(cfg Config) (*Function, error) {
	return newFunction(cfg, auth.NewVerifier(auth.Config{
		JWKSPath: cfg.JWKSPath,
		Issuer:   cfg.Issuer,
		Audience: cfg.Audience,
		Now:      cfg.Now,

		SeenCapacity: cfg.SeenCapacity,
		Logger:       cfg.Logger,
	}))
}

func newFunction(cfg Config, verifier auth.Verifier) (*Function, error) {
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	otelOptions := []otelconnect.Option{
		otelconnect.WithPropagator(propagation.NewCompositeTextMapPropagator(
			propagation.TraceContext{}, propagation.Baggage{},
		)),
	}
	if cfg.TracerProvider != nil {
		otelOptions = append(otelOptions, otelconnect.WithTracerProvider(cfg.TracerProvider))
	}
	otelInterceptor, err := otelconnect.NewServerInterceptor(otelOptions...)
	if err != nil {
		return nil, err
	}

	// Interceptors run in argument order, the first outermost: every RPC is
	// traced (refusals included), a panic is contained, and the token is
	// checked before any request payload is read. The wake-ahead probe
	// (/healthz, mounted below) is not an RPC, so it bypasses all three.
	rpc := connect.NewServer(
		otelInterceptor,
		recoverInterceptor,
		auth.NewInterceptor(verifier),
	)
	examplev1connect.RegisterExampleServiceHandler(rpc, items.NewService())
	grpchealth.Register(rpc, grpchealth.NewStaticChecker(examplev1connect.ExampleServiceName))

	mux := http.NewServeMux()
	connecthttp.Mount(mux, rpc,
		// connect-go v2.0.2+ stops decompressing one byte past this limit, so a
		// small gzip body cannot inflate to gigabytes (the health Check takes a
		// body with no token). go.mod requires v2.0.2 or later for that bound.
		connecthttp.WithReadMaxBytes(MaxRequestBytes),
	)
	// The wake-ahead probe: a plain GET, answered before and outside the token
	// check. A Connect GET of the health Check is not available, since the
	// generated health service does not mark Check side-effect free.
	mux.HandleFunc("GET /healthz", healthz)

	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	protocols.SetUnencryptedHTTP2(true)
	addr := cfg.Addr
	if addr == "" {
		addr = ":8080"
	}
	return &Function{
		HTTP: &http.Server{
			Addr:              addr,
			Handler:           http.MaxBytesHandler(mux, MaxRequestBodyBytes),
			Protocols:         protocols,
			ReadHeaderTimeout: ReadHeaderTimeout,
			ReadTimeout:       ReadTimeout,
			IdleTimeout:       IdleTimeout,
		},
		rpc:    rpc,
		logger: logger,
		mux:    mux,
	}, nil
}

// Specs lists every registered procedure.
func (f *Function) Specs() iter.Seq[connect.Spec] {
	return f.rpc.Specs()
}

// Serve serves on ln until ctx is done, then drains in-flight calls for up to
// ShutdownGrace. It returns nil after a clean shutdown.
func (f *Function) Serve(ctx context.Context, ln net.Listener) error {
	errs := make(chan error, 1)
	go func() { errs <- f.HTTP.Serve(ln) }()
	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), ShutdownGrace)
	defer cancel()
	if err := f.HTTP.Shutdown(shutdownCtx); err != nil {
		return err
	}
	if err := <-errs; !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// healthz answers the wake-ahead probe with 200 and no body. It carries no
// credentials and reads nothing, so it is never refused for lack of a token.
// The "GET" pattern also matches HEAD, which is refused with 405 as POST is by
// the mux, so the probe is GET-only in both templates.
func healthz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	w.WriteHeader(http.StatusOK)
}

// recoverInterceptor answers a panicking handler with CodeInternal, without
// the panic value, and logs it.
func recoverInterceptor(next connect.ServerFunc) connect.ServerFunc {
	return func(ctx context.Context, spec connect.Spec, stream connect.ServerStream) (err error) {
		defer func() {
			if r := recover(); r != nil {
				slog.ErrorContext(ctx, "handler panicked", "procedure", spec.Procedure, "panic", r)
				err = connect.NewError(connect.CodeInternal, "internal error")
			}
		}()
		return next(ctx, spec, stream)
	}
}
