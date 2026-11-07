# knext-ffi/src

## Overview
Runtime half of knext's in-process Rust (Beta): the C ABI (version 1) that `bun:ffi` calls, plus the JSON wire codec for records and other JSON-position values. User code annotates plain Rust with the re-exported `#[export]` / `#[record]` macros; everything under `__rt` is called only by macro-generated code and is not a stable API (`lib.rs` crate docs).

## Interface
- `lib.rs:export`, `lib.rs:record`: re-exports of `knext_ffi_macros::{export, record}`. Also re-exports `serde` and `serde_json` so generated code can name them through `::knext_ffi`.
- `lib.rs:ABI_VERSION` (`1`) and the shim status codes `STATUS_OK` (0), `STATUS_ERR` (1, `Err(e)`, out slot holds `e.to_string()`), `STATUS_PANIC` (2, panic message), `STATUS_INVALID_INPUT` (3, undecodable argument or unencodable JSON return).
- `lib.rs:knext_ffi_v1_free(ptr, len)`: `#[unsafe(no_mangle)] extern "C"`. It frees a buffer a shim returned. `(NULL, 0)` is a no-op.
- `lib.rs:knext_ffi_v1_abi() -> u32`: `extern "C"`, returns `ABI_VERSION`.
- `lib.rs:__rt` (doc-hidden, macro-only):
  - re-exports of the four `STATUS_*` constants
  - `Out` (`*mut [u64; 2]`), `Invalid(String)`
  - trait `Lower`: by-value impls for the integer, float and `bool` scalars, plus `()`, `String`, `Vec<u8>` and `Json<T>` (the wrapper for a return value that crosses as JSON)
  - `write_buf`, `bytes_arg`, `str_arg`, `json_arg`
  - `call` (the shim body runner)
  - `Schema { name, kind, canon, deps }`, trait `KnextSchema: Wire` (`const SCHEMA`; a `#[diagnostic::on_unimplemented]` message tells the user to add `#[knext_ffi::record]`), `MAX_SCHEMAS` (256), `schema_hash`
  - `pieces_len`, `pieces_concat` (compile-time manifest assembly)
- `wire.rs:Wire`: the trait with `ser` and `de`, implemented for:
  - `i8..u32`, `bool`, `String` (plain serde)
  - `f32`, `f64` (finite only)
  - `i64`, `u64`, `isize`, `usize` (decimal strings)
  - `Option<T>`, `Vec<T>`
- `wire.rs:Ser` and `wire.rs:De` (serialize or deserialize a `T` through its `Wire` impl), `wire.rs:Field` (doc-hidden; one record field, its name added to any error), `wire.rs:at` (doc-hidden; error path prefixer), and `wire.rs:serialize`, `wire.rs:deserialize` (the `#[serde(with = "::knext_ffi::wire")]` halves).

## Invariants
- `lib.rs` `compile_error!` refuses to build under `panic = "abort"`, on a non-64-bit target, or on a non-little-endian target.
- `__rt::call` wraps the shim body in `catch_unwind` and never unwinds across the boundary. A panic becomes `STATUS_PANIC` with its message (`panic_message` falls back to `"panic with a non-string payload"`), and dropping the panic payload is itself guarded.
- `__rt::bytes_arg` returns `&[]` when `len == 0` and never calls `slice::from_raw_parts` with a NULL pointer (`bun:ffi` passes an empty typed array as NULL).
- `__rt::write_buf` writes `[0, 0]` and allocates nothing for an empty value. Otherwise it hands over a `Box<[u8]>` as `(ptr, len)`, which must be released exactly once through `knext_ffi_v1_free`.
- `__rt::json_arg` rejects malformed JSON and trailing data (`de.end()`). `__rt::str_arg` rejects invalid UTF-8. Both report `Invalid`, which the shim maps to status 3.
- `wire.rs` (`decimal_string!`): every 64-bit integer in any JSON position is a decimal string, and a JSON number there is refused.
- `wire.rs` (`finite_float!`): a non-finite float fails serialization, with the error naming its path through `at`/`Field` (for example `[2]: f32 NaN ...`). A number that does not fit a finite float is refused on decode.
- `__rt::schema_hash` is FNV-1a 64 over `sig` followed by the `canon` of every reachable record or enum. Reachable schemas are collected transitively, deduplicated by name and sorted by name byte-wise. The function panics at compile time if more than `MAX_SCHEMAS` are reachable, or if two different schemas share a name.
- `__rt::pieces_concat` asserts that the concatenated length equals `N` (`"manifest length mismatch"`).

## Side Effects
- Heap allocation: `__rt::write_buf` leaks a boxed slice to the caller, and `knext_ffi_v1_free` reclaims it.
- Raw-pointer reads and writes through `Out` and the argument pointers (`unsafe`).
- No I/O, network or global state.

## Verification
- Run: `cargo test -p knext-ffi` (in `crates/`). This covers the `__rt::tests` (FNV vectors, transitive schema hash) and `wire::tests` unit tests.
