// Runs planIncludes over a list of include-pattern cases and prints one JSON
// line. Executed under BOTH node and bun by include-plan-runtime-parity.test.ts.
import { planIncludes } from "../../adapters/include-plan.mjs";

const [root, casesJson] = process.argv.slice(2);
const results = JSON.parse(casesJson).map((include) => {
    try {
        const plan = planIncludes(root, include);
        return { include, relpaths: plan.relpaths };
    } catch (e) {
        return {
            include,
            error: String(e?.message ?? e).split(root).join("<root>"),
        };
    }
});
console.log(JSON.stringify(results));
