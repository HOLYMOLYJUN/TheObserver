import * as cheerio from "cheerio";
import type { Company, Posting } from "../types.ts";
import { config } from "../config.ts";
import { log } from "../logger.ts";
import { fetchJson, fetchText } from "./fetcher.ts";

const API_BASE = "https://oapi.saramin.co.kr/job-search";
const WEB_SEARCH = "https://www.saramin.co.kr/zf_user/search/recruit";

/* ── 공식 API 경로 (1순위) ─────────────────────────────────────── */

/** 응답 스키마는 실제 호출로 확정 필요. 없는 필드에 대비해 전부 optional. */
interface SaraminApiResponse {
  jobs?: {
    count?: number;
    start?: number;
    total?: number;
    job?: SaraminApiJob[];
  };
}

interface SaraminApiJob {
  id?: string;
  url?: string;
  company?: { detail?: { name?: string; href?: string } };
  position?: {
    title?: string;
    location?: { name?: string };
    "experience-level"?: { name?: string };
    "job-type"?: { name?: string };
    "job-code"?: { name?: string };
  };
  "posting-date"?: string;
  "expiration-date"?: string;
  "expiration-timestamp"?: string;
}

async function collectViaApi(companies: Company[]): Promise<Posting[]> {
  const out: Posting[] = [];
  const seen = new Set<string>();

  // 회사마다 한 번씩 호출한다. 18곳 × 하루 2회 = 36회 → 일 500회 한도에 여유가 크다.
  for (const company of companies) {
    const keyword = company.saraminName ?? company.name;
    const url =
      `${API_BASE}?access-key=${encodeURIComponent(config.saraminAccessKey)}` +
      `&keywords=${encodeURIComponent(keyword)}` +
      `&count=50&sort=pd&fields=posting-date`;

    let res: SaraminApiResponse;
    try {
      res = await fetchJson<SaraminApiResponse>(url);
    } catch (err) {
      log.warn(`사람인 API 호출 실패 (${company.name}): ${(err as Error).message}`);
      continue;
    }

    for (const job of res.jobs?.job ?? []) {
      const id = job.id ?? job.url;
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const companyRaw = job.company?.detail?.name;
      const title = job.position?.title;
      const href = job.url ?? job.company?.detail?.href;
      if (!companyRaw || !title || !href) continue;

      out.push({
        sourceId: String(id),
        source: "saramin",
        companyRaw,
        title,
        url: href,
        location: job.position?.location?.name,
        experience: job.position?.["experience-level"]?.name,
        employmentType: job.position?.["job-type"]?.name,
        deadline: job["expiration-date"],
        postedAt: job["posting-date"],
      });
    }
  }
  return out;
}

/* ── 웹 파싱 경로 (API 키가 없거나 API가 죽었을 때) ─────────────── */

/**
 * 셀렉터는 resolve-companies 로 받은 실제 HTML을 보고 확정해야 한다.
 * 지금은 사람인 검색 결과의 관용적인 구조를 기준으로 두고,
 * 후보를 여러 개 시도해 하나라도 걸리면 채택한다.
 */
const SARAMIN_ITEM_SELECTORS = [
  ".item_recruit",
  ".content .list_item",
  "[class*='list_item']",
];

function parseSaraminSearchHtml(html: string): Posting[] {
  const $ = cheerio.load(html);
  const out: Posting[] = [];

  const selector = SARAMIN_ITEM_SELECTORS.find((s) => $(s).length > 0);
  if (!selector) return out;

  $(selector).each((_, el) => {
    const $el = $(el);
    const $title = $el.find("[class*='job_tit'] a, .area_job .job_tit a").first();
    const title = $title.attr("title")?.trim() || $title.text().trim();
    const href = $title.attr("href");
    const companyRaw = $el.find("[class*='corp_name'] a, .area_corp .corp_name a").first().text().trim();
    if (!title || !href || !companyRaw) return;

    const idAttr = $el.attr("value") ?? $el.attr("id") ?? "";
    const idFromHref = /rec_idx=(\d+)/.exec(href)?.[1];
    const sourceId = idFromHref ?? idAttr ?? href;

    const conditions = $el.find("[class*='job_condition'] span").map((__, s) => $(s).text().trim()).get();

    out.push({
      sourceId,
      source: "saramin",
      companyRaw,
      title,
      url: href.startsWith("http") ? href : `https://www.saramin.co.kr${href}`,
      location: conditions[0],
      experience: conditions[1],
      employmentType: conditions[3],
      deadline: $el.find("[class*='date']").first().text().trim() || undefined,
    });
  });

  return out;
}

async function collectViaWeb(companies: Company[]): Promise<Posting[]> {
  const out: Posting[] = [];
  const seen = new Set<string>();

  for (const company of companies) {
    const keyword = company.saraminName ?? company.name;
    const url = `${WEB_SEARCH}?searchword=${encodeURIComponent(keyword)}&recruitSort=reg_dt`;
    try {
      const html = await fetchText(url);
      for (const p of parseSaraminSearchHtml(html)) {
        if (seen.has(p.sourceId)) continue;
        seen.add(p.sourceId);
        out.push(p);
      }
    } catch (err) {
      log.warn(`사람인 웹 검색 실패 (${company.name}): ${(err as Error).message}`);
    }
  }
  return out;
}

/* ── 진입점 ────────────────────────────────────────────────────── */

export async function collectSaramin(
  companies: Company[],
): Promise<{ postings: Posting[]; usedFallback: boolean }> {
  if (config.saraminAccessKey) {
    const postings = await collectViaApi(companies);
    if (postings.length > 0) return { postings, usedFallback: false };
    log.warn("사람인 API가 결과를 0건 반환 — 웹 파싱으로 폴백합니다.");
  }
  return { postings: await collectViaWeb(companies), usedFallback: true };
}

export const __test = { parseSaraminSearchHtml };
