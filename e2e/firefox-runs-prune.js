/**
 * Deletes old Firefox E2E run records (`firefox-runs/`) so they do not grow
 * without bound. Deleted records stay in git history once the deletion is
 * committed.
 *
 *   cd e2e && npm run firefox:record:prune                 # keep the newest 20
 *   cd e2e && npm run firefox:record:prune -- --keep 5     # keep the newest 5
 *   cd e2e && npm run firefox:record:prune -- --keep 0     # clear every record
 *   cd e2e && npm run firefox:record:prune -- --dry-run    # only list them
 *
 * The default count is `FIREFOX_RECORDS_KEEP` or 20. `run-firefox.js` calls
 * pruneRecords after saving each record (it always keeps the new one).
 */
const { existsSync, readdirSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { parseArgs } = require("node:util");

const {
  DEFAULT_RECORDS_KEEP,
  RECORDS_DIR,
  selectRecordsToPrune,
} = require("./firefox-run-record");

const recordsDir = resolve(__dirname, "..", RECORDS_DIR);

/** `FIREFOX_RECORDS_KEEP` as a count, or the default. */
function keepFromEnv(env = process.env) {
  const value = env.FIREFOX_RECORDS_KEEP;
  return value === undefined || value === ""
    ? DEFAULT_RECORDS_KEEP
    : Number(value);
}

/** Deletes all but the newest `keep` records of `dir`; returns the deleted names. */
function pruneRecords(dir, keep, { dryRun = false } = {}) {
  if (!existsSync(dir)) return [];
  const pruned = selectRecordsToPrune(readdirSync(dir), keep);
  if (!dryRun) {
    for (const name of pruned) rmSync(join(dir, name));
  }
  return pruned;
}

module.exports = { keepFromEnv, pruneRecords };

if (require.main === module) {
  try {
    const { values } = parseArgs({
      options: {
        keep: { type: "string" },
        "dry-run": { type: "boolean", default: false },
      },
    });
    const keep =
      values.keep === undefined ? keepFromEnv() : Number(values.keep);
    const dryRun = values["dry-run"];
    const pruned = pruneRecords(recordsDir, keep, { dryRun });
    for (const name of pruned) {
      console.log(
        `${dryRun ? "would delete" : "deleted"} ${RECORDS_DIR}/${name}`,
      );
    }
    console.log(
      `[firefox:record:prune] ${pruned.length} record(s) ${dryRun ? "to delete" : "deleted"}, keeping the newest ${keep}`,
    );
  } catch (error) {
    // Bad arguments (an unknown option, a count that is not a non-negative integer).
    console.error(`[firefox:record:prune] ${error.message}`);
    process.exit(2);
  }
}
