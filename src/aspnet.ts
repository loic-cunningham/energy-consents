import { parse, type HTMLElement } from "node-html-parser";
import pLimit from "p-limit";

const HTTP_CONCURRENCY = Number(process.env.HTTP_CONCURRENCY ?? 6);
let httpLimit = pLimit(HTTP_CONCURRENCY);

export function setHttpConcurrency(n: number) {
  httpLimit = pLimit(Math.max(1, n));
}

export type ViewState = {
  __VIEWSTATE: string;
  __VIEWSTATEGENERATOR: string;
  __EVENTVALIDATION: string;
  __VIEWSTATEENCRYPTED?: string;
};

export class CookieJar {
  private jar = new Map<string, string>();

  ingest(headers: Headers) {
    const raw = headers.getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(";");
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

export function extractViewState(html: string): ViewState {
  const grab = (name: string) => {
    const re = new RegExp(
      `<input[^>]*name=\"${name}\"[^>]*value=\"([^\"]*)\"|<input[^>]*value=\"([^\"]*)\"[^>]*name=\"${name}\"`,
      "i",
    );
    const m = re.exec(html);
    return m ? (m[1] ?? m[2] ?? "") : "";
  };
  return {
    __VIEWSTATE: grab("__VIEWSTATE"),
    __VIEWSTATEGENERATOR: grab("__VIEWSTATEGENERATOR"),
    __EVENTVALIDATION: grab("__EVENTVALIDATION"),
    __VIEWSTATEENCRYPTED: grab("__VIEWSTATEENCRYPTED"),
  };
}

export function parseHtml(html: string): HTMLElement {
  return parse(html, {
    blockTextElements: { script: false, style: false, pre: false },
    parseNoneClosedTags: true,
  });
}

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export type FetchOpts = {
  jar: CookieJar;
  url: string;
  body?: Record<string, string>;
  referer?: string;
  retries?: number;
};

export async function httpGet(opts: FetchOpts): Promise<string> {
  return await request({ ...opts, method: "GET" });
}

export async function httpPost(opts: FetchOpts): Promise<string> {
  return await request({ ...opts, method: "POST" });
}

export async function httpPostRaw(
  opts: FetchOpts & { method?: "POST" },
): Promise<Response> {
  return await httpLimit(() => doFetchRaw({ ...opts, method: "POST" }));
}

async function request(
  opts: FetchOpts & { method: "GET" | "POST" },
): Promise<string> {
  const retries = opts.retries ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await httpLimit(() => doFetch(opts));
    } catch (err) {
      lastErr = err;
      const wait = 500 * Math.pow(2, attempt) + Math.random() * 250;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function doFetchRaw(
  opts: FetchOpts & { method: "GET" | "POST" },
): Promise<Response> {
  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
  };
  const cookieHeader = opts.jar.header();
  if (cookieHeader) headers["Cookie"] = cookieHeader;
  if (opts.referer) headers["Referer"] = opts.referer;

  let body: string | undefined;
  if (opts.method === "POST" && opts.body) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(opts.body).toString();
  }

  const res = await fetch(opts.url, {
    method: opts.method,
    headers,
    body,
    redirect: "manual",
  });
  opts.jar.ingest(res.headers);
  return res;
}

async function doFetch(
  opts: FetchOpts & { method: "GET" | "POST" },
): Promise<string> {
  const res = await doFetchRaw(opts);

  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location");
    if (loc) {
      const next = new URL(loc, opts.url).toString();
      return await doFetch({ ...opts, method: "GET", url: next, body: undefined });
    }
  }

  if (res.status === 503 || res.status === 429) {
    throw new Error(`HTTP ${res.status} (will retry)`);
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  return await res.text();
}

export function postbackBody(
  vs: ViewState,
  eventTarget: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const body: Record<string, string> = {
    __EVENTTARGET: eventTarget,
    __EVENTARGUMENT: "",
    __LASTFOCUS: "",
    __VIEWSTATE: vs.__VIEWSTATE,
    __VIEWSTATEGENERATOR: vs.__VIEWSTATEGENERATOR,
    __EVENTVALIDATION: vs.__EVENTVALIDATION,
    __SCROLLPOSITIONX: "0",
    __SCROLLPOSITIONY: "0",
    txtJSEnabled: "true",
    ...extra,
  };
  if (vs.__VIEWSTATEENCRYPTED !== undefined) {
    body.__VIEWSTATEENCRYPTED = vs.__VIEWSTATEENCRYPTED;
  }
  return body;
}
