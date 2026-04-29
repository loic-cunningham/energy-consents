import {
  CookieJar,
  extractViewState,
  httpGet,
  httpPost,
  postbackBody,
} from "./aspnet.ts";
import {
  findNextPagerTarget,
  parseCaseDetail,
  parseDocuments,
  parseRepresentations,
  type CaseRow,
  type CaseDetail,
  type DocumentEntry,
  type Representation,
} from "./parse.ts";
import { detailUrl, type Config } from "./config.ts";
import type { Logger } from "./logger.ts";

export type CaseRecord = CaseRow & {
  detail: CaseDetail;
  documents: DocumentEntry[];
  representations: Representation[];
  scrapedAt: string;
};

export async function scrapeCase(
  cfg: Config,
  row: CaseRow,
  logger: Logger,
): Promise<CaseRecord> {
  const jar = new CookieJar();
  const url = detailUrl(cfg, row.caseRef);
  const caseHtml = await httpGet({ jar, url });
  const detail = parseCaseDetail(caseHtml, row.caseRef, url);
  let vs = extractViewState(caseHtml);

  let documents: DocumentEntry[] = [];
  try {
    let docsHtml = await httpPost({
      jar,
      url,
      referer: url,
      body: postbackBody(vs, "ctl00$ContentPlaceHolder1$htpDocuments"),
    });
    vs = extractViewState(docsHtml);
    let docsPage = 1;
    documents = parseDocuments(docsHtml, url, docsPage);

    let safety = 50;
    while (safety-- > 0) {
      const nextTarget = findNextPagerTarget(docsHtml);
      if (!nextTarget) break;
      docsHtml = await httpPost({
        jar,
        url,
        referer: url,
        body: postbackBody(vs, nextTarget),
      });
      vs = extractViewState(docsHtml);
      docsPage++;
      const more = parseDocuments(docsHtml, url, docsPage);
      if (more.length === 0) break;
      documents.push(...more);
    }
  } catch (e) {
    logger.warn(`[case ${row.caseRef}] documents failed: ${(e as Error).message}`);
  }

  let representations: Representation[] = [];
  try {
    const repsHtml = await httpPost({
      jar,
      url,
      referer: url,
      body: postbackBody(vs, "ctl00$ContentPlaceHolder1$hypRepresentation"),
    });
    representations = parseRepresentations(repsHtml);
  } catch (e) {
    logger.warn(
      `[case ${row.caseRef}] representations failed: ${(e as Error).message}`,
    );
  }

  return {
    ...row,
    detail,
    documents,
    representations,
    scrapedAt: new Date().toISOString(),
  };
}
