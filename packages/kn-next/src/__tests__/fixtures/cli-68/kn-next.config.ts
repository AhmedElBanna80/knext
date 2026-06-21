/**
 * Fixture config for #68 — drives `node <emitted-bin> deploy --dry-run`.
 * Plain object so it loads under plain Node (v24 strips types on import).
 */
export default {
    name: "cli68-fixture-app",
    registry: "registry.example.com/cli68",
    storage: {
        provider: "gcs",
        bucket: "cli68-bucket",
        publicUrl: "https://storage.googleapis.com/cli68-bucket",
    },
    cache: {
        provider: "redis",
        url: "redis://redis:6379",
        keyPrefix: "cli68-fixture-app",
    },
    scaling: {
        minScale: 0,
        maxScale: 3,
    },
};
