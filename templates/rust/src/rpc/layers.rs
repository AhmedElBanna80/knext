//! The OpenTelemetry and panic-recovery layers.

use std::any::Any;
use std::convert::Infallible;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::task::{Context, Poll};

use bytes::Bytes;
use connectrpc::{ConnectError, ConnectRpcBody};
use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Either, Ready, ready};
use http::{HeaderMap, Method, Request, Response};
use http_body_util::Full;
use opentelemetry::KeyValue;
use opentelemetry::global::BoxedTracer;
use opentelemetry::propagation::{Extractor, TextMapCompositePropagator, TextMapPropagator};
use opentelemetry::trace::{SpanKind, Status, TraceContextExt, Tracer};
use opentelemetry_sdk::propagation::{BaggagePropagator, TraceContextPropagator};

/// Starts a server span for every call, continuing the caller's W3C trace
/// context (`traceparent`, `tracestate`, `baggage`). The span's context is
/// put in the request's extensions, where a handler reads it with
/// `ctx.extensions().get::<opentelemetry::Context>()` to continue the trace
/// on its own outgoing calls.
#[derive(Clone)]
pub struct TraceLayer {
    tracer: Arc<BoxedTracer>,
    propagator: Arc<TextMapCompositePropagator>,
}

impl TraceLayer {
    pub fn new(tracer: BoxedTracer) -> Self {
        Self {
            tracer: Arc::new(tracer),
            propagator: Arc::new(TextMapCompositePropagator::new(vec![
                Box::new(TraceContextPropagator::new()),
                Box::new(BaggagePropagator::new()),
            ])),
        }
    }
}

impl<S> tower::Layer<S> for TraceLayer {
    type Service = TraceService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        TraceService {
            inner,
            layer: self.clone(),
        }
    }
}

#[derive(Clone)]
pub struct TraceService<S> {
    inner: S,
    layer: TraceLayer,
}

struct Headers<'a>(&'a HeaderMap);

impl Extractor for Headers<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(|v| v.to_str().ok())
    }

    fn keys(&self) -> Vec<&str> {
        self.0.keys().map(http::HeaderName::as_str).collect()
    }
}

impl<S, B> tower::Service<Request<B>> for TraceService<S>
where
    S: tower::Service<Request<B>, Response = Response<ConnectRpcBody>, Error = Infallible>,
    S::Future: Send + 'static,
{
    type Response = Response<ConnectRpcBody>;
    type Error = Infallible;
    type Future = BoxFuture<'static, Result<Self::Response, Infallible>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Infallible>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, mut req: Request<B>) -> Self::Future {
        let parent = self.layer.propagator.extract(&Headers(req.headers()));
        let procedure = req.uri().path().trim_start_matches('/').to_owned();
        let (service, method) = procedure
            .split_once('/')
            .unwrap_or((procedure.as_str(), ""));
        let span = self
            .layer
            .tracer
            .span_builder(procedure.clone())
            .with_kind(SpanKind::Server)
            .with_attributes([
                KeyValue::new("rpc.system", "connect_rpc"),
                KeyValue::new("rpc.service", service.to_owned()),
                KeyValue::new("rpc.method", method.to_owned()),
            ])
            .start_with_context(self.layer.tracer.as_ref(), &parent);
        let cx = parent.with_span(span);
        req.extensions_mut().insert(cx.clone());
        let call = self.inner.call(req);
        Box::pin(async move {
            let resp = call.await?;
            let span = cx.span();
            span.set_attribute(KeyValue::new(
                "http.response.status_code",
                i64::from(resp.status().as_u16()),
            ));
            if !resp.status().is_success() {
                span.set_status(Status::error(resp.status().to_string()));
            }
            span.end();
            Ok(resp)
        })
    }
}

/// The path of the wake-ahead probe: a plain GET, answered before the token
/// check. A Connect GET of the health Check is not available, since the
/// generated health service does not mark Check side-effect free.
pub const HEALTHZ_PATH: &str = "/healthz";

/// Answers the wake-ahead probe with 200 and no body. It carries no
/// credentials and reads nothing, so it is never refused for lack of a token.
/// Any other method on the path gets 405 with `Allow: GET`, as the Go template
/// answers it, so the probe is GET-only in both templates.
#[derive(Debug, Clone, Copy)]
pub struct HealthzLayer;

impl<S> tower::Layer<S> for HealthzLayer {
    type Service = HealthzService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        HealthzService { inner }
    }
}

#[derive(Debug, Clone)]
pub struct HealthzService<S> {
    inner: S,
}

impl<S, B> tower::Service<Request<B>> for HealthzService<S>
where
    S: tower::Service<Request<B>, Response = Response<ConnectRpcBody>>,
{
    type Response = Response<ConnectRpcBody>;
    type Error = S::Error;
    type Future = Either<S::Future, Ready<Result<Self::Response, S::Error>>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Request<B>) -> Self::Future {
        if req.uri().path() == HEALTHZ_PATH {
            let body = ConnectRpcBody::Full(Full::new(Bytes::new()));
            let mut resp = Response::new(body);
            if req.method() == Method::GET {
                *resp.status_mut() = http::StatusCode::OK;
            } else {
                *resp.status_mut() = http::StatusCode::METHOD_NOT_ALLOWED;
                resp.headers_mut()
                    .insert(http::header::ALLOW, http::HeaderValue::from_static("GET"));
            }
            return Either::Right(ready(Ok(resp)));
        }
        Either::Left(self.inner.call(req))
    }
}

/// Answers a panicking handler with `internal`, without the panic value,
/// and logs it. The function keeps serving.
#[derive(Debug, Clone, Copy)]
pub struct RecoverLayer;

impl<S> tower::Layer<S> for RecoverLayer {
    type Service = RecoverService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        RecoverService { inner }
    }
}

#[derive(Debug, Clone)]
pub struct RecoverService<S> {
    inner: S,
}

impl<S, B> tower::Service<Request<B>> for RecoverService<S>
where
    S: tower::Service<Request<B>, Response = Response<ConnectRpcBody>, Error = Infallible>,
    S::Future: Send + 'static,
{
    type Response = Response<ConnectRpcBody>;
    type Error = Infallible;
    type Future = BoxFuture<'static, Result<Self::Response, Infallible>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Infallible>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Request<B>) -> Self::Future {
        let headers = req.headers().clone();
        let procedure = req.uri().path().to_owned();
        let call = std::panic::catch_unwind(AssertUnwindSafe(|| self.inner.call(req)));
        Box::pin(async move {
            let outcome = match call {
                Ok(call) => AssertUnwindSafe(call).catch_unwind().await,
                Err(panic) => Err(panic),
            };
            match outcome {
                Ok(resp) => resp,
                Err(panic) => {
                    tracing::error!(
                        procedure,
                        panic = panic_message(panic.as_ref()),
                        "handler panicked"
                    );
                    Ok(ConnectError::internal("internal error").into_http_response(&headers))
                }
            }
        })
    }
}

fn panic_message(panic: &(dyn Any + Send)) -> &str {
    panic
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| panic.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("non-string panic")
}
