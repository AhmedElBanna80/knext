# knext-ffi-macros/src

## Overview
Proc-macro crate (`Cargo.toml`: `proc-macro = true`) behind `knext_ffi::export` and `knext_ffi::record`. The macros classify Rust types against the ABI v1 type table, generate the `extern "C"` shim and `_schema` companion for each export, derive the JSON encoding of each record, and embed a `KNEXTFFI1` manifest record for each export and each record or enum. The TypeScript wrapper is generated from those manifest records.

## Interface
- `lib.rs:export`: a `#[proc_macro_attribute]` that delegates to `export::expand`.
- `lib.rs:record`: a `#[proc_macro_attribute]` that delegates to `record::expand`.
- `export.rs:expand`, `export.rs:analyze` (returns `Analysis { name, sig, symbol, .. }`). For each `pub fn`, the private `emit` generates:
  - the shim `pub unsafe extern "C" fn knext_ffi_v1_<fn>_<fnv1a32(sig):08x>(..args, __knext_out: *mut [u64; 2]) -> i32`, which runs through `::knext_ffi::__rt::call`
  - `<symbol>_schema() -> u64`, const-evaluated by `__rt::schema_hash`
  - the `#[used]` static `__KNEXT_FFI_MANIFEST_<symbol>`
- `record.rs:expand`: on a named-field struct, `expand_struct` generates:
  - `serde::Deserialize` with `deny_unknown_fields`, and a per-field `deserialize_with = "::knext_ffi::wire::deserialize"`
  - a hand-written `Serialize` that writes every field through `wire::Field`
  - `KnextSchema` (`kind: "record"`, `canon` `Name{field:tok,...}`), `Wire`, and the static `__KNEXT_FFI_MANIFEST_record_<Name>`

  On a unit-only enum, `expand_enum` generates `Serialize` + `Deserialize`, `KnextSchema` (`kind: "enum"`, `canon` `Name[A|B]`), `Wire`, and `__KNEXT_FFI_MANIFEST_enum_<Name>`.
- `types.rs`:
  - `classify(ty, Pos) -> (Desc, Mode)`, with the enums `Pos { Arg, Ret, Json }`, `Desc` and `Mode`
  - `Desc::token` (the canonical type token), `Desc::named`, `Desc::mentions`, `Desc::pieces`
  - `Pieces` (`lit`, `expr`, `to_tokens`), `json_str`, `fnv1a32`, `doc_of`, `pretty`, `reject`, `is_u8`, and the constant `TABLE_HINT` (a pointer to the public type-mapping docs page, appended to every rejection)

## Invariants
- `export.rs:analyze` rejects the following:
  - non-`pub` fns
  - `async`, `unsafe`, `extern` (explicit ABI), generic or variadic fns
  - non-ASCII names
  - methods (`self` receivers)
  - non-identifier argument patterns

  `export::expand` rejects an item that is not a fn ("goes on a free `pub fn`"). `export::expand` and `record::expand` both reject attribute arguments ("takes no arguments in ABI v1").
- `export.rs:analyze` builds the canonical signature as `name(tok,...)->tok`. A `Result<T, E>` return is spelled as `T`, and the `r#` prefix is stripped. The symbol hash covers the canonical signature, so a type or order change changes the symbol, while renaming an argument or switching between borrowed and owned (`&str` vs `String`) does not (`export.rs` tests).
- `types.rs:classify` determines how each position crosses:
  - Top-level `Vec<u8>` and `&[u8]` are `bytes`, and inside JSON `Vec<u8>` is `vec<u8>`.
  - `()` is valid only as a return.
  - References are allowed only as `&str` or `&[u8]` arguments, with no lifetime and no `mut`.
- `types.rs:classify` rejects the following, each with a message naming the type plus `TABLE_HINT`:
  - `char`, `i128`/`u128`, an unborrowed `str`, `Self`
  - tuples, arrays, slices, raw pointers, `impl Trait`, trait objects, fn pointers, `!`, qualified paths
  - generic types other than `Option`/`Vec`, and `Result` anywhere except the return
  - an `Option` nested directly inside an `Option`
- `record.rs` refuses any `#[serde(...)]` attribute (`no_serde_attrs`), generic records, non-ASCII names, tuple and unit structs, data-carrying or empty enums, and a record whose field names the record itself (`Desc::mentions`).
- `types.rs:json_str` escapes control characters including NUL, so a manifest record contains no raw NUL before its terminating `\0`.

## Side Effects
- Compile-time token generation only. The generated code places `#[unsafe(no_mangle)]` symbols and `#[used]` manifest statics in the user's library.

## Verification
- Run: `cargo test -p knext-ffi-macros` (in `crates/`) for the unit tests in `types.rs` and `export.rs`. The trybuild rejection cases live in `knext-ffi` (`cargo test -p knext-ffi`).
