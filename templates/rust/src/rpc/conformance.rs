//! The function's stack with the token check left out, for the Connect
//! conformance suite (`conformance.sh`) and nothing else.
//!
//! The suite's runner sends no zone identity token, so it can only reach the
//! server through this build: the same accept loop, timeouts, body bound,
//! recovery, tracing and health layers as [`super::new`], assembled by the
//! same function, with only the token check missing. It exists behind the
//! repository-only `conformance` feature, which `knext add function` does not
//! copy, and it refuses to compile in a release build, so no image can carry
//! it.

#[cfg(not(debug_assertions))]
compile_error!(
    "the `conformance` feature turns the token check off and must never build in release; \
     conformance.sh builds it with the dev profile"
);

use connectrpc::Router;

use super::{Config, Function, MAX_REQUEST_BYTES, assemble};

/// The stack serving `router` with no token check. `message_limit` is the
/// runner's per-message receive limit (0 for none), applied in place of the
/// function's own [`MAX_REQUEST_BYTES`] so the suite's limit cases test it.
pub fn unauthenticated(router: Router, message_limit: usize) -> Function {
    let max_message = if message_limit > 0 {
        message_limit
    } else {
        MAX_REQUEST_BYTES
    };
    assemble(router, None, Config::default(), max_message)
}
