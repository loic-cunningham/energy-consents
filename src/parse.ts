import { parseHtml } from "./aspnet.ts";

const cleanup = (s: string) =>
  s
    .replace(/ /g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const stripTags = (s: string) => s.replace(/<[^>]+>/g, "");

export type CaseRow = {
  caseRef: string;
  projectName: string;
  caseType: string;
  projectType: string;
  caseStatus: string;
};

export type SearchResults = {
  rows: CaseRow[];
  currentPage: number;
  totalPages: number;
};

export function parseSearchResults(html: string): SearchResults {
  const root = parseHtml(html);
  const grid = root.getElementById("ContentPlaceHolder1_grdResults");
  const rows: CaseRow[] = [];
  if (grid) {
    const trs = grid.querySelectorAll("tr");
    for (const tr of trs.slice(1)) {
      const tds = tr.querySelectorAll("td");
      if (tds.length < 5) continue;
      const refBtn = tds[0]!.querySelector("input[type=submit]");
      const caseRef = cleanup(refBtn?.getAttribute("value") ?? tds[0]!.text);
      if (!caseRef) continue;
      rows.push({
        caseRef,
        projectName: cleanup(tds[1]!.text),
        caseType: cleanup(tds[2]!.text),
        projectType: cleanup(tds[3]!.text),
        caseStatus: cleanup(tds[4]!.text),
      });
    }
  }

  const pageSize = 100;
  const display = /Displaying\s+Results\s+(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/i.exec(html);
  let currentPage = 1;
  let totalPages = 1;
  if (display) {
    const from = Number(display[1]);
    const total = Number(display[3]);
    currentPage = Math.ceil(from / pageSize);
    totalPages = Math.ceil(total / pageSize);
  } else {
    const pageInfo = /Page\s+(\d+)\s+of\s+(\d+)/i.exec(html);
    if (pageInfo) {
      currentPage = Number(pageInfo[1]);
      totalPages = Number(pageInfo[2]);
    }
  }
  return { rows, currentPage, totalPages };
}

export function findNextPagerTarget(html: string): string | null {
  const root = parseHtml(html);
  const links = root.querySelectorAll("a[id*=rptPager]");
  for (const a of links) {
    if (cleanup(a.text) === ">") {
      const m = /__doPostBack\('([^']+)'/.exec(a.getAttribute("href") ?? "");
      if (m) return m[1] ?? null;
    }
  }
  return null;
}

export type ContactBlock = { role: string; lines: string[] };

export type CaseDetail = {
  caseRef: string;
  url: string;
  fields: Record<string, string>;
  contacts: ContactBlock[];
};

export function parseCaseDetail(
  html: string,
  caseRef: string,
  url: string,
): CaseDetail {
  const root = parseHtml(html);
  const fields: Record<string, string> = {};
  const contacts: ContactBlock[] = [];

  const detail =
    root.getElementById("ContentPlaceHolder1_divCaseInformation") ?? root;

  const rows = detail.querySelectorAll("div.divRowCaseDetails");
  for (const row of rows) {
    const label = row.querySelector("label");
    const valueEl = row.querySelector("div.divRowCellCaseDetailsValue");
    if (!label || !valueEl) continue;
    const key = cleanup(label.text).replace(/:$/, "");
    if (!key) continue;
    const lines = valueEl.innerHTML
      .split(/<br\s*\/?>/i)
      .map((s) => cleanup(stripTags(s)))
      .filter(Boolean);
    if (lines.length > 1) {
      contacts.push({ role: key, lines });
      fields[key] = lines.join(" | ");
    } else {
      fields[key] = lines[0] ?? "";
    }
  }

  return { caseRef, url, fields, contacts };
}

export type DocumentEntry = {
  dateReceived: string;
  publicationDate: string;
  documentCategory: string;
  description: string;
  postbackTarget: string;
  documentId: string;
  pageOnDocsTab: number;
  rowIndexOnPage: number;
  downloadEndpoint: string;
};

export function parseDocuments(
  html: string,
  downloadEndpoint = "",
  pageOnDocsTab = 1,
): DocumentEntry[] {
  const root = parseHtml(html);
  const grid = root.getElementById("ContentPlaceHolder1_grdResults");
  const out: DocumentEntry[] = [];
  if (!grid) return out;

  const headers = grid
    .querySelectorAll("tr:first-child th, tr:first-child td")
    .map((th) => cleanup(th.text).toLowerCase());
  const idx = (label: string) => headers.findIndex((h) => h.includes(label));
  const iDate = idx("date received");
  const iPub = idx("publication");
  const iCat = idx("category");
  const iDesc = idx("description");

  const rows = grid.querySelectorAll("tr").slice(1);
  let rowIndexOnPage = 0;
  for (const tr of rows) {
    const tds = tr.querySelectorAll("td");
    if (tds.length < 4) continue;
    const link = tr.querySelector("a[id*=AddButton]");
    const href = link?.getAttribute("href") ?? "";
    const m = /__doPostBack\('([^']+)'/.exec(href);
    const postbackTarget = m?.[1] ?? "";
    const description = cleanup(link?.text ?? tds[iDesc >= 0 ? iDesc : 3]!.text);
    out.push({
      dateReceived: cleanup(tds[iDate >= 0 ? iDate : 0]!.text),
      publicationDate: cleanup(tds[iPub >= 0 ? iPub : 1]!.text),
      documentCategory: cleanup(tds[iCat >= 0 ? iCat : 2]!.text),
      description,
      postbackTarget,
      documentId: link?.getAttribute("id") ?? "",
      pageOnDocsTab,
      rowIndexOnPage: rowIndexOnPage++,
      downloadEndpoint,
    });
  }
  return out;
}

export type Representation = { fields: Record<string, string> };

export function parseRepresentations(html: string): Representation[] {
  const root = parseHtml(html);
  const grid = root.getElementById("ContentPlaceHolder1_grdResults");
  if (!grid) return [];
  const headerCells = grid
    .querySelectorAll("tr:first-child th, tr:first-child td")
    .map((th) => cleanup(th.text));
  const out: Representation[] = [];
  const rows = grid.querySelectorAll("tr").slice(1);
  for (const tr of rows) {
    const tds = tr.querySelectorAll("td");
    if (tds.length === 0) continue;
    const fields: Record<string, string> = {};
    tds.forEach((td, i) => {
      const key = headerCells[i] || `col_${i}`;
      fields[key] = cleanup(td.text);
    });
    out.push({ fields });
  }
  return out;
}

export function parseFilenameFromHeader(disposition: string | null): string | null {
  if (!disposition) return null;
  const m = /filename\*=UTF-8''([^;]+)|filename="([^"]+)"|filename=([^;]+)/i.exec(
    disposition,
  );
  if (!m) return null;
  const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim();
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function safeFilename(s: string): string {
  return s.replace(/[\/\\:*?"<>|]/g, "_").trim() || "document";
}
