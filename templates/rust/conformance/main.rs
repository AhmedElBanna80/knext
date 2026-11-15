// The conformance server's `main`, spliced by `conformance.sh` onto the
// upstream connect-rust conformance server (`conformance/src/bin/server.rs` at
// the pinned commit) in place of the upstream `main`. Everything above this
// point in the built file is the upstream ConformanceService implementation;
// this part serves it through the function's own stack instead of the
// upstream `Server`: the template's accept loop, timeouts, body bound and
// layers (`function::rpc::conformance::unauthenticated`), with only the token
// check left out, since the runner sends no zone identity token.
//
// No TLS: a function serves h2c inside the cluster, and the suite config
// (`conformance/config.yaml`) says so.

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
    init_type_registry();

    let request: ServerCompatRequest =
        read_message()?.ok_or_else(|| anyhow::anyhow!("Expected ServerCompatRequest on stdin"))?;
    if request.use_tls {
        anyhow::bail!("the function's stack serves h2c only; the suite config must not ask for TLS");
    }

    let router = Arc::new(ConformanceServiceImpl).register(Router::new());
    let function = function::rpc::conformance::unauthenticated(
        router,
        request.message_receive_limit as usize,
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    write_message(&ServerCompatResponse {
        host: "127.0.0.1".to_string(),
        port: port as u32,
        ..Default::default()
    })?;
    tracing::info!(port, "serving the conformance service on the function's stack");

    function.serve(listener, std::future::pending()).await?;
    Ok(())
}
