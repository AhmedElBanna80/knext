import { unstable_cache } from "next/cache";
import { connection } from "next/server";

/**
 * The single-exec rollback lane's cache signal (scripts/single-exec-rollback-kind.sh).
 * The page is rendered on every request (`connection()`), so its stamp comes from
 * the `unstable_cache` entry itself, never from a stored page: the same stamp
 * under every build means each build read the one entry in the shared Redis.
 */
const stamp = unstable_cache(
    async () => `${new Date().toISOString()}#${Math.random().toString(36).slice(2, 10)}`,
    ["rb-e2e-stamp"],
    { revalidate: 3600 },
);

export default async function RbStamp() {
    await connection();
    return <p id="stamp">{await stamp()}</p>;
}
