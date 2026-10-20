// Runs every *.test.ts file in the given folders, one at a time, each in its
// own process, and fails if any of them fails.
// usage: node scripts/run-test-files.mjs <folder> [<folder> ...]
//
// The files use node:test but are run directly rather than with
// `node --test`. Under --test, each file's results come back to the parent
// runner as a serialized stream, and on CI that stream intermittently could not
// be read ("Unable to deserialize cloned data due to invalid or unsupported
// version"), failing a run in which every test had passed. Run directly, a file
// prints its own results and exits non-zero when a test fails, so nothing has
// to be deserialized.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const folders = process.argv.slice(2);
const files = folders.flatMap((folder) =>
  fs.readdirSync(folder)
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => path.join(folder, name)),
);
if (files.length === 0) {
  console.error(`No *.test.ts files in ${folders.join(", ") || "(no folders given)"}.`);
  process.exit(1);
}

const failed = [];
for (const file of files) {
  console.log(`\n# ${file}`);
  const { status, signal, error } = spawnSync(process.execPath, [tsxCli, file], { stdio: "inherit" });
  if (error || status !== 0) failed.push(`${file} (${error?.message ?? signal ?? `exit ${status}`})`);
}

console.log(`\n${files.length - failed.length} of ${files.length} test files passed.`);
if (failed.length) {
  console.error(`Failed:\n  ${failed.join("\n  ")}`);
  process.exit(1);
}
