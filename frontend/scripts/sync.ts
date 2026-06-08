#!/usr/bin/env node
/** `dante sync` replacement — TS edition.
 *
 * Usage:
 *   bun run scripts/sync.ts                  # all sources, full window
 *   bun run scripts/sync.ts --source personio
 *   bun run scripts/sync.ts --source awork --skip-awork-maintenance
 *   bun run scripts/sync.ts --absence-days 90 --skip-attendances
 *
 * Same flag surface as the Python CLI so existing muscle memory + cron
 * scripts keep working.
 */
import { runSync, type SyncOptions } from "../lib/sync/run";

function parseArgs(argv: string[]): SyncOptions {
  const opts: SyncOptions = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`flag ${a} requires a value`);
      return v;
    };
    switch (a) {
      case "--source":
      case "-s": {
        const v = next();
        if (v !== "all" && v !== "personio" && v !== "awork") {
          throw new Error(`--source must be all|personio|awork (got ${v})`);
        }
        opts.source = v;
        break;
      }
      case "--absence-days":
        opts.absence_days = Number(next());
        break;
      case "--attendance-days":
        opts.attendance_days = Number(next());
        break;
      case "--time-entry-days":
        opts.time_entry_days = Number(next());
        break;
      case "--skip-absences":
        opts.skip_absences = true;
        break;
      case "--skip-attendances":
        opts.skip_attendances = true;
        break;
      case "--skip-compensations":
        opts.skip_compensations = true;
        break;
      case "--skip-time-entries":
        opts.skip_time_entries = true;
        break;
      case "--skip-awork-maintenance":
        opts.skip_awork_maintenance = true;
        break;
      case "--help":
      case "-h":
        console.log(`Usage: bun run scripts/sync.ts [options]

  --source, -s [all|personio|awork]   (default: all)
  --absence-days N                    (default: 365)
  --attendance-days N                 (default: 365)
  --time-entry-days N                 (default: 365)
  --skip-absences
  --skip-attendances
  --skip-compensations
  --skip-time-entries
  --skip-awork-maintenance`);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag: ${a}`);
    }
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  await runSync(opts);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
