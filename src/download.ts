import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import {
  CookieJar,
  extractViewState,
  httpGet,
  httpPost,
  httpPostRaw,
  postbackBody,
} from "./aspnet.ts";
import {
  findNextPagerTarget,
  parseDocuments,
  parseFilenameFromHeader,
  safeFilename,
  type DocumentEntry,
} from "./parse.ts";
import { detailUrl, type Config } from "./config.ts";
import type { Logger } from "./logger.ts";

export type DownloadResult = {
  caseRef: string;
  pageOnDocsTab: number;
  rowIndexOnPage: number;
  documentId: string;
  description: string;
  filename: string;
  bytes: number;
  savedTo: string;
  contentType: string;
};

export type CaseDocsManifest = {
  caseRef: string;
  fetchedAt: string;
  total: number;
  files: DownloadResult[];
};

async function openDocsSession(
  cfg: Config,
  caseRef: string,
): Promise<{
  jar: CookieJar;
  url: string;
  vs: ReturnType<typeof extractViewState>;
  pageHtml: string;
}> {
  const url = detailUrl(cfg, caseRef);
  const jar = new CookieJar();
  const caseHtml = await httpGet({ jar, url });
  let vs = extractViewState(caseHtml);
  const pageHtml = await httpPost({
    jar,
    url,
    referer: url,
    body: postbackBody(vs, "ctl00$ContentPlaceHolder1$htpDocuments"),
  });
  vs = extractViewState(pageHtml);
  return { jar, url, vs, pageHtml };
}

async function pageForwardTo(
  jar: CookieJar,
  url: string,
  startHtml: string,
  startVs: ReturnType<typeof extractViewState>,
  targetPage: number,
): Promise<{ html: string; vs: ReturnType<typeof extractViewState> }> {
  let html = startHtml;
  let vs = startVs;
  for (let p = 1; p < targetPage; p++) {
    const next = findNextPagerTarget(html);
    if (!next) throw new Error(`no next page from ${p}`);
    html = await httpPost({
      jar,
      url,
      referer: url,
      body: postbackBody(vs, next),
    });
    vs = extractViewState(html);
  }
  return { html, vs };
}

async function fetchDocumentBinary(
  jar: CookieJar,
  url: string,
  vs: ReturnType<typeof extractViewState>,
  postbackTarget: string,
): Promise<{ buf: Uint8Array; filename: string; contentType: string }> {
  const res = await httpPostRaw({
    jar,
    url,
    referer: url,
    body: postbackBody(vs, postbackTarget),
  });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const disp = res.headers.get("content-disposition");
  const ct = res.headers.get("content-type") ?? "application/octet-stream";
  const filename = parseFilenameFromHeader(disp) ?? `document-${Date.now()}`;
  return { buf, filename, contentType: ct };
}

export async function downloadOneDoc(
  cfg: Config,
  args: { caseRef: string; pageOnDocsTab: number; rowIndexOnPage: number },
): Promise<DownloadResult> {
  const session = await openDocsSession(cfg, args.caseRef);
  const { html, vs } = await pageForwardTo(
    session.jar,
    session.url,
    session.pageHtml,
    session.vs,
    args.pageOnDocsTab,
  );

  const docs = parseDocuments(html, session.url, args.pageOnDocsTab);
  const row = docs[args.rowIndexOnPage];
  if (!row) {
    throw new Error(
      `row ${args.rowIndexOnPage} missing on page ${args.pageOnDocsTab} (${docs.length} rows)`,
    );
  }

  const { buf, filename, contentType } = await fetchDocumentBinary(
    session.jar,
    session.url,
    vs,
    row.postbackTarget,
  );

  const outDir = path.join(cfg.dataDir, args.caseRef, "documents");
  await mkdir(outDir, { recursive: true });
  const savedTo = path.join(outDir, safeFilename(filename));
  await writeFile(savedTo, buf);

  return {
    caseRef: args.caseRef,
    pageOnDocsTab: args.pageOnDocsTab,
    rowIndexOnPage: args.rowIndexOnPage,
    documentId: row.documentId,
    description: row.description,
    filename,
    bytes: buf.byteLength,
    savedTo,
    contentType,
  };
}

async function listAllDocs(
  cfg: Config,
  caseRef: string,
): Promise<Array<{ pageOnDocsTab: number; rowIndexOnPage: number; documentId: string; description: string }>> {
  const session = await openDocsSession(cfg, caseRef);
  let html = session.pageHtml;
  let vs = session.vs;
  const out: ReturnType<typeof parseDocuments> = [];
  let pageNum = 1;
  let safety = 50;
  while (safety-- > 0) {
    const rows = parseDocuments(html, session.url, pageNum);
    out.push(...rows);
    const nextTarget = findNextPagerTarget(html);
    if (!nextTarget) break;
    html = await httpPost({
      jar: session.jar,
      url: session.url,
      referer: session.url,
      body: postbackBody(vs, nextTarget),
    });
    vs = extractViewState(html);
    pageNum++;
  }
  return out.map(({ pageOnDocsTab, rowIndexOnPage, documentId, description }) => ({
    pageOnDocsTab,
    rowIndexOnPage,
    documentId,
    description,
  }));
}

export async function downloadAllDocsForCase(
  cfg: Config,
  caseRef: string,
  logger: Logger,
  perCaseConcurrency = 4,
): Promise<CaseDocsManifest> {
  const docs = await listAllDocs(cfg, caseRef);
  const outDir = path.join(cfg.dataDir, caseRef, "documents");
  await mkdir(outDir, { recursive: true });

  const limit = pLimit(perCaseConcurrency);
  const results: DownloadResult[] = [];
  await Promise.all(
    docs.map((d) =>
      limit(async () => {
        try {
          const r = await downloadOneDoc(cfg, {
            caseRef,
            pageOnDocsTab: d.pageOnDocsTab,
            rowIndexOnPage: d.rowIndexOnPage,
          });
          results.push(r);
        } catch (e) {
          logger.warn(
            `[doc ${caseRef} p${d.pageOnDocsTab}r${d.rowIndexOnPage}] ${(e as Error).message}`,
          );
        }
      }),
    ),
  );
  results.sort(
    (a, b) =>
      a.pageOnDocsTab - b.pageOnDocsTab ||
      a.rowIndexOnPage - b.rowIndexOnPage,
  );

  const manifest: CaseDocsManifest = {
    caseRef,
    fetchedAt: new Date().toISOString(),
    total: results.length,
    files: results,
  };
  const manifestPath = path.join(cfg.dataDir, caseRef, "documents.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return manifest;
}
