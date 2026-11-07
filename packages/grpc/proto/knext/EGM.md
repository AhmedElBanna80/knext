# proto/knext

## Overview

Groups the versioned knext protobuf packages. Today it holds one version,
`v1`.

## Subdirectories & Boundaries

- v1: [./v1/EGM.md](./v1/EGM.md) - the `knext.v1` options contract
  (`options.proto`): the `function` (50701) and `contract_version` (50702) file
  options and the `Auth` enum used by the `auth` (50703) method option.
