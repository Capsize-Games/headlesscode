// npx tsx scripts/self-improvement-stats.mjs [--repo <path>]
//
// Prints self-improvement metrics as JSON to stdout, from the same
// computeSelfImprovementMetrics() function used by the dashboard server.
//
import { computeSelfImprovementMetrics } from "../src/dashboard/self-improvement-metrics.js";
import * as process from "node:process";

async function main() {
  let repo = process.cwd();
  
  // Parse CLI args for --repo <path>
  const args = process.argv.slice(2);
  if (args.length > 0 && args[0] === "--repo") {
    if (args.length >= 2) {
      repo = args[1];
    }
  }

  try {
    const result = await computeSelfImprovementMetrics(repo);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

main();