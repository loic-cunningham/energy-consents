#!/usr/bin/env bun
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import pc from "picocolors";

import { setHttpConcurrency } from "./aspnet.ts";
import { buildConfig } from "./config.ts";
import { collectAllCaseRefs } from "./index-step.ts";
import { scrapeCase, type CaseRecord } from "./scrape.ts";
import {
  downloadAllDocsForCase,
  downloadOneDoc,
} from "./download.ts";
import { banner, createProgress, plainLogger } from "./logger.ts";
import type { CaseRow } from "./parse.ts";

type CommonOpts = {
  baseUrl: string;
  dataDir: string;
  refs: string;
  output: string;
  httpConcurrency: number;
};

const commonOptions = {
  "base-url": {
    type: "string" as const,
    default: "https://www.energyconsents.scot",
    describe: "Site base URL",
  },
  "data-dir": {
    type: "string" as const,
    default: "data",
    describe: "Output directory for JSON/JSONL files and downloads",
  },
  refs: {
    type: "string" as const,
    describe: "Path to case_refs.json (defaults to <data-dir>/case_refs.json)",
  },
  output: {
    type: "string" as const,
    describe:
      "Path to output JSONL (defaults to <data-dir>/energy_consents.jsonl)",
  },
  "http-concurrency": {
    type: "number" as const,
    default: 6,
    describe: "Max in-flight HTTP requests across all workers",
  },
};

function makeConfig(argv: CommonOpts) {
  setHttpConcurrency(argv.httpConcurrency);
  return buildConfig({
    baseUrl: argv.baseUrl,
    dataDir: argv.dataDir,
    refsFile: argv.refs,
    output: argv.output,
  });
}

async function loadRefs(refsFile: string): Promise<CaseRow[]> {
  const f = Bun.file(refsFile);
  if (!(await f.exists())) {
    throw new Error(`refs file not found: ${refsFile} — run \`index\` first`);
  }
  return JSON.parse(await f.text());
}

async function loadDoneRefs(jsonlPath: string): Promise<Set<string>> {
  const f = Bun.file(jsonlPath);
  if (!(await f.exists())) return new Set();
  const text = await f.text();
  const done = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.caseRef) done.add(obj.caseRef);
    } catch {}
  }
  return done;
}

const args = hideBin(process.argv);
const noArgs = args.length === 0;
const wantsHelp = args.includes("--help") || args.includes("-h");
if (noArgs || (wantsHelp && args.length === 1)) {
  banner();
  console.log(
    `  ${pc.dim("Scrapes every case and document from")} ${pc.cyan("energyconsents.scot")}\n` +
      `  ${pc.dim("Resumable, paginated, polite. Stores everything as JSON / JSONL.")}\n`,
  );
  console.log(`  ${pc.bold("Commands")}`);
  console.log(
    `    ${pc.cyan("index")}      ${pc.dim("Crawl the search-result pages and write data/case_refs.json")}`,
  );
  console.log(
    `    ${pc.cyan("scrape")}     ${pc.dim("Fetch case detail + documents + representations into JSONL")}`,
  );
  console.log(
    `    ${pc.cyan("download")}   ${pc.dim("Download document binaries (single doc, whole case, or every case)")}`,
  );
  console.log();
  console.log(`  ${pc.bold("Quickstart")}`);
  console.log(`    ${pc.dim("$")} bun run src/cli.ts index`);
  console.log(`    ${pc.dim("$")} bun run src/cli.ts scrape`);
  console.log(`    ${pc.dim("$")} bun run src/cli.ts download --case ECU00004696`);
  console.log();
  console.log(
    `  See ${pc.cyan("bun run src/cli.ts <command> --help")} for command-specific options.`,
  );
  console.log();
  process.exit(0);
}

await yargs(args)
  .scriptName("energy-consents")
  .usage(`${pc.bold("energy-consents")} ${pc.dim("<command>")} [options]`)
  .strict()
  .demandCommand(1, pc.red("Specify a command: index | scrape | download"))
  .recommendCommands()
  .option(commonOptions)
  .command(
    "index",
    "Crawl the search results and dump every case ref to data/case_refs.json",
    () => {},
    async (argv) => {
      banner();
      const cfg = makeConfig(argv as unknown as CommonOpts);
      const logger = plainLogger();
      await mkdir(cfg.dataDir, { recursive: true });
      const refs = await collectAllCaseRefs(cfg, logger);
      await writeFile(cfg.refsFile, JSON.stringify(refs, null, 2));
      logger.success(
        `wrote ${pc.bold(String(refs.length))} refs to ${pc.cyan(cfg.refsFile)}`,
      );
    },
  )
  .command(
    "scrape",
    "Scrape case detail + documents + representations into JSONL (and optionally download files)",
    (y) =>
      y
        .option("case", {
          type: "string",
          describe: "Scrape a single case ref instead of the full list",
        })
        .option("limit", {
          type: "number",
          describe: "Process at most this many cases",
        })
        .option("concurrency", {
          type: "number",
          default: 4,
          describe: "Cases processed in parallel",
        })
        .option("resume", {
          type: "boolean",
          default: true,
          describe:
            "Skip cases already present in the output JSONL (use --no-resume to start fresh)",
        })
        .option("download", {
          type: "boolean",
          default: false,
          describe:
            "Also download every document into data/<caseRef>/documents/ + write documents.json",
        }),
    async (argv) => {
      banner();
      const cfg = makeConfig(argv as unknown as CommonOpts);
      await mkdir(cfg.dataDir, { recursive: true });

      let refs: CaseRow[];
      if (argv.case) {
        refs = [
          {
            caseRef: argv.case,
            projectName: "",
            caseType: "",
            projectType: "",
            caseStatus: "",
          },
        ];
      } else {
        refs = await loadRefs(cfg.refsFile);
      }

      if (!argv.resume) {
        await writeFile(cfg.outputJsonl, "");
      }
      const done = argv.resume ? await loadDoneRefs(cfg.outputJsonl) : new Set<string>();
      let todo = refs.filter((r) => !done.has(r.caseRef));
      if (typeof argv.limit === "number") todo = todo.slice(0, argv.limit);

      console.log(
        `  ${pc.dim("total")}     ${pc.bold(String(refs.length))}\n` +
          `  ${pc.dim("done")}      ${pc.green(String(done.size))}\n` +
          `  ${pc.dim("to process")} ${pc.cyan(String(todo.length))}` +
          (argv.download ? `  ${pc.dim("(+downloads)")}` : ""),
      );
      console.log();

      if (todo.length === 0) {
        console.log(`  ${pc.green("✓")} nothing to do`);
        return;
      }

      const progress = createProgress({
        total: todo.length,
        label: argv.download ? "scrape+download" : "scrape",
      });

      const limit = pLimit(argv.concurrency);
      let writeQueue: Promise<unknown> = Promise.resolve();
      let n = 0;
      let okCount = 0;
      let failCount = 0;

      const tasks = todo.map((row) =>
        limit(async () => {
          try {
            const rec: CaseRecord = await scrapeCase(cfg, row, progress);

            const caseDir = path.join(cfg.dataDir, rec.caseRef);
            await mkdir(caseDir, { recursive: true });
            await writeFile(
              path.join(caseDir, "case.json"),
              JSON.stringify(rec, null, 2),
            );

            const line = JSON.stringify(rec) + "\n";
            writeQueue = writeQueue.then(() =>
              appendFile(cfg.outputJsonl, line),
            );
            await writeQueue;

            if (argv.download) {
              try {
                const m = await downloadAllDocsForCase(cfg, rec.caseRef, progress);
                progress.log(
                  `[case ${rec.caseRef}] downloaded ${m.total} docs`,
                );
              } catch (e) {
                progress.warn(
                  `[case ${rec.caseRef}] downloads failed: ${(e as Error).message}`,
                );
              }
            }

            okCount++;
          } catch (e) {
            failCount++;
            progress.error(
              `[case ${row.caseRef}] failed: ${(e as Error).message}`,
            );
          } finally {
            n++;
            progress.bar.update(n, { label: row.caseRef });
          }
        }),
      );

      await Promise.all(tasks);
      progress.stop();
      console.log();
      console.log(
        `  ${pc.green("✓")} done  ${pc.dim("|")} ` +
          `ok ${pc.green(String(okCount))} ${pc.dim("|")} ` +
          `fail ${failCount > 0 ? pc.red(String(failCount)) : pc.dim("0")} ` +
          `${pc.dim("|")} ${pc.cyan(cfg.outputJsonl)}`,
      );
    },
  )
  .command(
    "download",
    "Download document binaries for one or many cases (replays ASP.NET postbacks)",
    (y) =>
      y
        .option("case", {
          type: "string",
          describe: "Case ref. Required unless --all is set.",
        })
        .option("page", {
          type: "number",
          describe: "Documents-tab page (1-based). If omitted, downloads all docs of the case.",
        })
        .option("row", {
          type: "number",
          describe:
            "0-based row index on that page. Required when --page is set for single-doc mode.",
        })
        .option("all", {
          type: "boolean",
          default: false,
          describe: "Download every doc for every case in case_refs.json",
        })
        .option("concurrency", {
          type: "number",
          default: 2,
          describe: "Cases processed in parallel when --all is used",
        })
        .option("limit", {
          type: "number",
          describe: "When --all, stop after this many cases",
        }),
    async (argv) => {
      banner();
      const cfg = makeConfig(argv as unknown as CommonOpts);
      const logger = plainLogger();
      await mkdir(cfg.dataDir, { recursive: true });

      if (argv.all) {
        const refs = await loadRefs(cfg.refsFile);
        const todo =
          typeof argv.limit === "number" ? refs.slice(0, argv.limit) : refs;

        const progress = createProgress({
          total: todo.length,
          label: "download-all",
        });

        const limit = pLimit(argv.concurrency);
        let n = 0;
        await Promise.all(
          todo.map((row) =>
            limit(async () => {
              try {
                const m = await downloadAllDocsForCase(cfg, row.caseRef, progress);
                progress.log(`[case ${row.caseRef}] ${m.total} files`);
              } catch (e) {
                progress.error(
                  `[case ${row.caseRef}] ${(e as Error).message}`,
                );
              } finally {
                n++;
                progress.bar.update(n, { label: row.caseRef });
              }
            }),
          ),
        );
        progress.stop();
        return;
      }

      if (!argv.case) {
        throw new Error("--case is required (or use --all)");
      }

      if (typeof argv.page === "number") {
        if (typeof argv.row !== "number") {
          throw new Error("--row is required when --page is given");
        }
        const result = await downloadOneDoc(cfg, {
          caseRef: argv.case,
          pageOnDocsTab: argv.page,
          rowIndexOnPage: argv.row,
        });
        logger.success(
          `${pc.bold(result.filename)} ` +
            `${pc.dim("(")}${(result.bytes / 1024).toFixed(1)} KB${pc.dim(")")} ` +
            `→ ${pc.cyan(result.savedTo)}`,
        );
        return;
      }

      const m = await downloadAllDocsForCase(cfg, argv.case, logger);
      logger.success(
        `case ${pc.bold(m.caseRef)}: ${pc.green(String(m.total))} files → ` +
          pc.cyan(path.join(cfg.dataDir, m.caseRef, "documents")),
      );
    },
  )
  .example("bun run src/cli.ts index", "Crawl the search and write data/case_refs.json")
  .example(
    "bun run src/cli.ts scrape --limit 50",
    "Scrape the first 50 cases (resumable)",
  )
  .example(
    "bun run src/cli.ts scrape --case EC00002069 --download",
    "Scrape one case and pull every document",
  )
  .example(
    "bun run src/cli.ts download --case ECU00004696",
    "Download every document for a single case",
  )
  .help()
  .alias("h", "help")
  .wrap(Math.min(110, process.stdout.columns ?? 100))
  .epilogue(pc.dim("docs: https://github.com/loic-cunningham/energy-consents"))
  .fail((msg, err, y) => {
    if (err) throw err;
    console.error();
    console.error(`  ${pc.red("error")} ${msg}`);
    console.error();
    console.error(y.help());
    process.exit(1);
  })
  .parseAsync();
