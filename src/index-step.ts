import {
  CookieJar,
  extractViewState,
  httpGet,
  httpPost,
  postbackBody,
} from "./aspnet.ts";
import {
  findNextPagerTarget,
  parseSearchResults,
  type CaseRow,
} from "./parse.ts";
import type { Config } from "./config.ts";
import { searchUrl } from "./config.ts";
import type { Logger } from "./logger.ts";

export async function collectAllCaseRefs(
  cfg: Config,
  logger: Logger,
): Promise<CaseRow[]> {
  const url = searchUrl(cfg);
  const jar = new CookieJar();
  logger.log(`[index] GET ${url}`);
  let html = await httpGet({ jar, url });
  let vs = extractViewState(html);

  logger.log(`[index] POST search submit`);
  html = await httpPost({
    jar,
    url,
    referer: url,
    body: {
      ...postbackBody(vs, ""),
      "ctl00$ContentPlaceHolder1$txtAdvCaseRef": "",
      "ctl00$ContentPlaceHolder1$txtAdvProjectName": "",
      "ctl00$ContentPlaceHolder1$txtAdvEcduReference": "",
      "ctl00$ContentPlaceHolder1$ddlAdvPlanningAuthority": "",
      "ctl00$ContentPlaceHolder1$txtAdvDateOfEnquiryFrom": "",
      "ctl00$ContentPlaceHolder1$txtAdvDateOfEnquiryTo": "",
      "ctl00$ContentPlaceHolder1$ddlAdvCaseType": "",
      "ctl00$ContentPlaceHolder1$ddlAdvCaseStatus": "",
      "ctl00$ContentPlaceHolder1$txtAdvDecisionFrom": "",
      "ctl00$ContentPlaceHolder1$txtAdvDecisionTo": "",
      "ctl00$ContentPlaceHolder1$cmdSearchAdvanced": "Go",
    },
  });

  vs = extractViewState(html);
  let { rows, currentPage, totalPages } = parseSearchResults(html);
  const all: CaseRow[] = [...rows];
  logger.log(
    `[index] page ${currentPage}/${totalPages}: +${rows.length} (total ${all.length})`,
  );

  while (currentPage < totalPages) {
    const target = findNextPagerTarget(html);
    if (!target) {
      logger.warn(`[index] no next pager link from page ${currentPage}`);
      break;
    }
    html = await httpPost({
      jar,
      url,
      referer: url,
      body: postbackBody(vs, target),
    });
    vs = extractViewState(html);
    const parsed = parseSearchResults(html);
    rows = parsed.rows;
    currentPage = parsed.currentPage;
    totalPages = parsed.totalPages;
    all.push(...rows);
    logger.log(
      `[index] page ${currentPage}/${totalPages}: +${rows.length} (total ${all.length})`,
    );
  }

  return all;
}
