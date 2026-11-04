/**
 * Port selection for specs that spawn a server and rebind the port in the
 * child.
 *
 * A bare `20000 + random * 20000` puts 36% of draws in the Linux ephemeral
 * range (32768-60999), where any outbound socket on the runner can hold the
 * port, and nothing checks it is free. The Nitro server swallows an
 * EADDRINUSE on listen and exits 0 with no output, so the collision surfaced
 * as an unexplained `code=0`.
 *
 * Draw below the ephemeral range, and only hand out a port that binds now and
 * that this process has not already handed out. A listener started by another
 * process between this check and the child's bind is still possible, so
 * `waitForHttpOk` diagnoses a silent exit instead of hiding it.
 */

import { createServer } from "node:net";

/** First port of the Linux ephemeral range; draws stay below it. */
const EPHEMERAL_START = 32768;
const RANGE_START = 20000;

const handedOut = new Set<number>();

export interface PickServerPortOptions {
    /** Injectable for tests. */
    random?: () => number;
    /** Injectable for tests. Default: bind the port on `::` and release it. */
    isFree?: (port: number) => Promise<boolean>;
    /** Draws before giving up. Default 50. */
    attempts?: number;
}

/** True when `port` can be bound on the wildcard address right now. */
export function canBind(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const s = createServer();
        s.once("error", () => resolve(false));
        s.listen({ port, host: "::" }, () => s.close(() => resolve(true)));
    });
}

export async function pickServerPort(
    opts: PickServerPortOptions = {},
): Promise<number> {
    const random = opts.random ?? Math.random;
    const isFree = opts.isFree ?? canBind;
    const attempts = opts.attempts ?? 50;
    for (let i = 0; i < attempts; i++) {
        const port =
            RANGE_START +
            Math.floor(random() * (EPHEMERAL_START - RANGE_START));
        if (handedOut.has(port)) continue;
        if (!(await isFree(port))) continue;
        handedOut.add(port);
        return port;
    }
    throw new Error(
        `no free port in ${RANGE_START}-${EPHEMERAL_START - 1} after ${attempts} attempts`,
    );
}
