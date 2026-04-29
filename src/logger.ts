import cliProgress from "cli-progress";
import pc from "picocolors";

export type Logger = {
  log: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  info: (msg: string) => void;
  success: (msg: string) => void;
};

export type ProgressLogger = Logger & {
  bar: cliProgress.SingleBar;
  stop: () => void;
};

const ANSI_CLEAR_LINE = "\x1b[2K\r";

export function plainLogger(): Logger {
  return {
    log: (m) => console.log(m),
    warn: (m) => console.warn(`${pc.yellow("warn")}  ${m}`),
    error: (m) => console.error(`${pc.red("error")} ${m}`),
    info: (m) => console.log(`${pc.cyan("info")}  ${m}`),
    success: (m) => console.log(`${pc.green("ok")}    ${m}`),
  };
}

export function banner(scriptName = "energy-consents") {
  if (!process.stdout.isTTY) return;
  const title = pc.bold(pc.cyan(scriptName));
  const sub = pc.dim("scraper for energyconsents.scot");
  console.log();
  console.log(`  ${title}  ${sub}`);
  console.log();
}

export function createProgress(opts: {
  total: number;
  label?: string;
}): ProgressLogger {
  const bar = new cliProgress.SingleBar(
    {
      format:
        `  ${pc.cyan("{bar}")} ${pc.bold("{percentage}%")} ` +
        `${pc.dim("|")} ${pc.green("{value}")}${pc.dim("/")}{total} ` +
        `${pc.dim("|")} ETA ${pc.yellow("{eta_formatted}")} ` +
        `${pc.dim("|")} ${pc.dim("{label}")}`,
      barCompleteChar: "█",
      barIncompleteChar: "░",
      hideCursor: true,
      clearOnComplete: false,
      stopOnComplete: false,
      forceRedraw: true,
    },
    cliProgress.Presets.shades_classic,
  );

  bar.start(opts.total, 0, { label: opts.label ?? "" });

  const writeAbove = (prefix: string, msg: string) => {
    if (process.stdout.isTTY) {
      process.stdout.write(ANSI_CLEAR_LINE + prefix + msg + "\n");
      bar.updateETA();
      bar.render();
    } else {
      console.log(prefix + msg);
    }
  };

  return {
    bar,
    log: (m) => writeAbove("", m),
    info: (m) => writeAbove(`${pc.cyan("info")}  `, m),
    warn: (m) => writeAbove(`${pc.yellow("warn")}  `, m),
    error: (m) => writeAbove(`${pc.red("error")} `, m),
    success: (m) => writeAbove(`${pc.green("ok")}    `, m),
    stop: () => bar.stop(),
  };
}
