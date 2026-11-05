# A knext Rust zone function: a static musl binary on distroless, run as a
# non-root user.
#
# Both base images are DIGEST-PINNED so the bytes of the image are fixed; the
# tag is kept in the comment above each FROM (Docker rejects a trailing
# comment on a FROM line). Refresh the tag and digest together:
#   docker buildx imagetools inspect rust:1.99.1-alpine3.23
#   docker buildx imagetools inspect gcr.io/distroless/static:nonroot
# The Rust release must match the channel in rust-toolchain.toml.
#
# `cargo auditable` embeds the dependency list in the binary, so an image
# scanner (Trivy, syft) sees every crate compiled into it.

# rust:1.99.1-alpine3.23
FROM rust:1.99.1-alpine3.23@sha256:5ddfbe04e0ab00287676bc5d37dbaca8f547e73144c3e561e3e6ee395120d8f4 AS build
RUN apk add --no-cache musl-dev
RUN cargo install --locked --root /usr/local cargo-auditable@0.7.7
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY vendor vendor
RUN mkdir -p src e2e && echo 'fn main() {}' > src/main.rs && touch src/lib.rs e2e/e2e.rs \
    && cargo fetch --locked
COPY gen gen
COPY src src
RUN cargo auditable build --release --locked --bin function \
    && cp target/release/function /function

# gcr.io/distroless/static:nonroot
FROM gcr.io/distroless/static:nonroot@sha256:25ac8f0c3b2334a9eb05452266bd4697864a8c8ef0ef71e5e6480d7f92868329
COPY --from=build /function /function
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/function"]
