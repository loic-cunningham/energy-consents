import path from "node:path";

export type Config = {
  baseUrl: string;
  searchPath: string;
  detailPath: string;
  dataDir: string;
  refsFile: string;
  outputJsonl: string;
};

export function buildConfig(opts: {
  baseUrl?: string;
  dataDir?: string;
  refsFile?: string;
  output?: string;
}): Config {
  const baseUrl = (opts.baseUrl ?? "https://www.energyconsents.scot").replace(
    /\/$/,
    "",
  );
  const dataDir = opts.dataDir ?? "data";
  return {
    baseUrl,
    searchPath: "/ApplicationSearch.aspx?T=2",
    detailPath: "/ApplicationDetails.aspx",
    dataDir,
    refsFile: opts.refsFile ?? path.join(dataDir, "case_refs.json"),
    outputJsonl: opts.output ?? path.join(dataDir, "energy_consents.jsonl"),
  };
}

export function searchUrl(cfg: Config): string {
  return cfg.baseUrl + cfg.searchPath;
}

export function detailUrl(cfg: Config, caseRef: string): string {
  return `${cfg.baseUrl}${cfg.detailPath}?cr=${encodeURIComponent(caseRef)}`;
}
