import * as cheerio from "cheerio";
import type { Company, Posting } from "../types.ts";
import { log } from "../logger.ts";
import { fetchText, fetchRenderedHtml } from "./fetcher.ts";

const ORIGIN = "https://www.jobkorea.co.kr";

/**
 * 잡코리아는 공식 오픈 API가 없다. 두 가지 경로를 쓴다.
 *   A) 회사 코드를 아는 경우 → /company/{code}/Recruit  (정확)
 *   B) 모르는 경우           → /Search/?stext={회사명}   (넓게 긁고 매칭으로 거름)
 * 회사 코드는 resolve-companies 워크플로가 채워준다.
 */
function companyRecruitUrl(code: string): string {
  return `${ORIGIN}/company/${encodeURIComponent(code)}/Recruit`;
}

function searchUrl(keyword: string): string {
  return `${ORIGIN}/Search/?stext=${encodeURIComponent(keyword)}&tabType=recruit&Page_No=1`;
}

/**
 * 실제 셀렉터는 라이브 HTML로 확정해야 한다 (resolve-companies 아티팩트).
 * 그때까지는 후보를 순서대로 시도하고, 어느 것도 안 걸리면 0건을 반환해
 * 상위에서 브라우저 폴백을 시도하게 한다.
 */
const ITEM_SELECTORS = [
  ".list-post",
  ".recruit-info .list-item",
  "tr.devloopArea",
  "[class*='list-item']",
];

const TITLE_SELECTORS = ["a.title", ".post-list-info a.title", ".title a", "a[href*='GI_Read']"];
const COMPANY_SELECTORS = ["a.name", ".post-list-corp a", ".name a", "[class*='corp'] a"];

function pickText($el: cheerio.Cheerio<any>, selectors: string[]): { text: string; href?: string } {
  for (const sel of selectors) {
    const $hit = $el.find(sel).first();
    if ($hit.length === 0) continue;
    const text = ($hit.attr("title") || $hit.text() || "").trim();
    if (text) return { text, href: $hit.attr("href") ?? undefined };
  }
  return { text: "" };
}

/** 잡코리아 공고 URL에서 공고 번호를 뽑는다: /Recruit/GI_Read/12345678 */
function extractPostingId(href: string): string | null {
  return /GI_Read\/(\d+)/.exec(href)?.[1] ?? /Gno=(\d+)/.exec(href)?.[1] ?? null;
}

export function parseJobkoreaHtml(html: string, fallbackCompany?: string): Posting[] {
  const $ = cheerio.load(html);
  const out: Posting[] = [];
  const seen = new Set<string>();

  const selector = ITEM_SELECTORS.find((s) => $(s).length > 0);
  if (!selector) {
    // 목록 컨테이너를 못 찾으면, 최소한 공고 링크라도 긁어본다.
    $("a[href*='GI_Read']").each((_, a) => {
      const href = $(a).attr("href") ?? "";
      const id = extractPostingId(href);
      const title = ($(a).attr("title") || $(a).text() || "").trim();
      if (!id || !title || seen.has(id)) return;
      seen.add(id);
      out.push({
        sourceId: id,
        source: "jobkorea",
        companyRaw: fallbackCompany ?? "",
        title,
        url: href.startsWith("http") ? href : `${ORIGIN}${href}`,
      });
    });
    return out;
  }

  $(selector).each((_, el) => {
    const $el = $(el);
    const title = pickText($el, TITLE_SELECTORS);
    if (!title.text || !title.href) return;

    const id = extractPostingId(title.href);
    if (!id || seen.has(id)) return;
    seen.add(id);

    const company = pickText($el, COMPANY_SELECTORS);
    const options = $el.find("[class*='option'] span, .etc, .exp, .loc")
      .map((__, s) => $(s).text().trim())
      .get()
      .filter(Boolean);

    out.push({
      sourceId: id,
      source: "jobkorea",
      companyRaw: company.text || fallbackCompany || "",
      title: title.text,
      url: title.href.startsWith("http") ? title.href : `${ORIGIN}${title.href}`,
      experience: options.find((o) => /경력|신입/.test(o)),
      location: options.find((o) => /시|도|구$|군$/.test(o)),
      employmentType: options.find((o) => /정규|계약|인턴|파견|프리랜서/.test(o)),
      deadline: $el.find("[class*='date'], .day").first().text().trim() || undefined,
    });
  });

  return out;
}

/** HTTP로 먼저 시도하고, 파싱 결과가 0건이면 브라우저로 한 번 더 */
async function loadAndParse(url: string, fallbackCompany: string): Promise<{ postings: Posting[]; usedFallback: boolean }> {
  try {
    const html = await fetchText(url);
    const postings = parseJobkoreaHtml(html, fallbackCompany);
    if (postings.length > 0) return { postings, usedFallback: false };
    log.warn(`잡코리아 HTTP 파싱 0건 — 브라우저로 재시도: ${url}`);
  } catch (err) {
    log.warn(`잡코리아 HTTP 실패 (${fallbackCompany}): ${(err as Error).message}`);
  }

  try {
    const html = await fetchRenderedHtml(url, "a[href*='GI_Read']");
    return { postings: parseJobkoreaHtml(html, fallbackCompany), usedFallback: true };
  } catch (err) {
    log.warn(`잡코리아 브라우저 폴백도 실패 (${fallbackCompany}): ${(err as Error).message}`);
    return { postings: [], usedFallback: true };
  }
}

export async function collectJobkorea(
  companies: Company[],
): Promise<{ postings: Posting[]; usedFallback: boolean }> {
  const all: Posting[] = [];
  const seen = new Set<string>();
  let usedFallback = false;

  for (const company of companies) {
    const url = company.jobkoreaCode
      ? companyRecruitUrl(company.jobkoreaCode)
      : searchUrl(company.name);

    const result = await loadAndParse(url, company.name);
    usedFallback ||= result.usedFallback;

    for (const p of result.postings) {
      if (seen.has(p.sourceId)) continue;
      seen.add(p.sourceId);
      // 회사 페이지에서 긁은 건 회사명이 비어 있을 수 있으니 채워준다
      if (!p.companyRaw && company.jobkoreaCode) p.companyRaw = company.name;
      all.push(p);
    }
  }

  return { postings: all, usedFallback };
}
