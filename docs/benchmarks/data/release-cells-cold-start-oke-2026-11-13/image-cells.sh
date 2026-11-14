#!/usr/bin/env bash
set -euo pipefail
REG=us-central1-docker.pkg.dev/gsw-mcp/knative-next-repo
: > /workspace/digests.txt
for cell in node-turbopack node-webpack bun-turbopack bun-webpack; do
  rt=${cell%-*}
  cd /workspace/bc13-$cell
  if [ "$rt" = bun ]; then T=standalone-bun; A=""; else T=standalone-node; A="--build-arg KNEXT_HEALTH_CHECK_PATH=/api/health"; fi
  echo "=== IMAGE $cell target=$T"
  DOCKER_BUILDKIT=1 docker build --platform linux/amd64 -f Dockerfile.standalone --target $T $A -t $REG/bc13-$cell:$BUILD_ID . 2>&1 | tail -12
  docker push $REG/bc13-$cell:$BUILD_ID 2>&1 | tail -1
  echo "$cell $(docker inspect --format '{{index .RepoDigests 0}}' $REG/bc13-$cell:$BUILD_ID)" | tee -a /workspace/digests.txt
done
echo "=== DIGESTS"; cat /workspace/digests.txt
