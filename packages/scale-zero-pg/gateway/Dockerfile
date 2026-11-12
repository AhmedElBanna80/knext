# Multi-stage build: static Go binary -> distroless.
# golang:1.26.11, digest-pinned (scripts/check-base-images-pinned.sh). Keep the tag equal to go.mod's go line by hand: no guard checks it.
FROM golang:1.26.11@sha256:957952ae74dc010608717144399a59a2c6e82ea03d63be1c7ff6577c5a135f93 AS build
WORKDIR /src

# Cache modules first.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /gateway ./cmd/gateway \
 && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /alertsink ./cmd/alertsink \
 && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /pswatcher ./cmd/pswatcher \
 && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /appdb-operator ./cmd/appdb-operator \
 && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /writer-autoscaler ./cmd/writer-autoscaler \
 && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /zone-operator ./cmd/zone-operator

# gcr.io/distroless/static:nonroot
FROM gcr.io/distroless/static:nonroot@sha256:e2e927ec666bae08560abb3c55d0659eceabb657f56b6782ab500a9fc7f555e3
COPY --from=build /gateway /gateway
COPY --from=build /alertsink /alertsink
# pageserver auto-failover controller; the 58-pswatcher Deployment overrides
# ENTRYPOINT to /pswatcher (same image, distinct binary).
COPY --from=build /pswatcher /pswatcher
# AppDatabase CRD operator (ADR-0004, #96); the 83-appdb-operator Deployment
# overrides ENTRYPOINT to /appdb-operator (same image, distinct binary).
COPY --from=build /appdb-operator /appdb-operator
# Writer vertical-autoscaler (#103); the 85-writer-autoscaler Deployment overrides
# ENTRYPOINT to /writer-autoscaler (same image, distinct binary).
COPY --from=build /writer-autoscaler /writer-autoscaler
# Zone CRD operator (ADR-0007, #139 v2-2); the 87-zone-operator Deployment overrides
# ENTRYPOINT to /zone-operator (same image, distinct binary).
COPY --from=build /zone-operator /zone-operator
# Postgres wire port + metrics/health port.
EXPOSE 55432 9090
USER nonroot:nonroot
ENTRYPOINT ["/gateway"]
