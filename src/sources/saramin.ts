import * as cheerio from "cheerio";
import type { Company, Posting } from "../types.ts";
import { config } from "../config.ts";
import { log } from "../logger.ts";
import { normalizeCompany } from "../normalize.ts";
import { fetchJson, fetchText } from "./fetcher.ts";

const API_BASE = "https://oapi.saramin.co.kr/job-search";
const ORIGIN = "https://www.saramin.co.kr";

/* ── 웹 경로 ────────────────────────────────────────────────────
 * 기업 검색 페이지는 서버 렌더링이며, 검색된 법인마다
 *   div.item_corp
 *     h2.corp_name > a[href*="csn=..."]   상호 + 기업 식별자
 *     dl > dt"기업주소" + dd               동명이인 법인 구분용
 *     ul.list_ongoing > li                진행중 공고 목록
 *       h2.job_tit > a[href*="rec_idx="]  공고 제목/링크
 *       div.job_condition > span          지역 / 경력 / 학력 / 고용형태
 *       div.job_date .date                마감일
 * 구조를 그대로 담고 있다. 회사별 공고를 한 번의 요청으로 가져올 수 있다.
 */
function companySearchUrl(keyword: string): string {
  return `${ORIGIN}/zf_user/search/company?searchType=search&searchword=${encodeURIComponent(keyword)}`;
}

function parseCondition(spans: string[]): Pick<Posting, "location" | "experience" | "employmentType"> {
  return {
    location: spans.find((s) => /[시도군구읍면]$|^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충[북남]|전[북남]|경[북남]|제주)/.test(s)),
    experience: spans.find((s) => /경력|신입|무관/.test(s) && !/학력/.test(s)),
    employmentType: spans.find((s) => /정규|계약|인턴|파견|프리랜서|아르바이트|위촉/.test(s)),
  };
}

/** item_corp 블록 하나에서 진행중 공고를 뽑는다 */
function parseCorpBlock($: cheerio.CheerioAPI, el: never, companyName: string): Posting[] {
  const $el = $(el);
  return $el
    .find("ul.list_ongoing > li")
    .map((_, li): Posting | null => {
      const $li = $(li);
      const $a = $li.find("h2.job_tit a").first();
      const href = $a.attr("href") ?? "";
      const recIdx = /rec_idx=(\d+)/.exec(href)?.[1];
      const title = ($a.attr("title") || $a.text()).trim();
      if (!recIdx || !title) return null;

      const spans = $li
        .find(".job_condition span")
        .map((__, s) => $(s).text().replace(/\s+/g, " ").trim())
        .get()
        .filter(Boolean);

      return {
        sourceId: recIdx,
        source: "saramin" as const,
        companyRaw: companyName,
        title,
        // 검색 파라미터가 잔뜩 붙은 relay URL 대신 정규 공고 URL 로 바꾼다
        url: `${ORIGIN}/zf_user/jobs/relay/view?rec_idx=${recIdx}`,
        ...parseCondition(spans),
        deadline: $li.find(".job_date .date").first().text().trim() || undefined,
      };
    })
    .get()
    .filter((p): p is Posting => p !== null);
}

/**
 * 회사 하나를 조회한다.
 * 확정된 csn 이 있으면 그 법인 블록만 읽고, 없으면 상호가 일치하는 블록을 찾는다.
 */
async function collectCompany(company: Company): Promise<Posting[]> {
  // 확정 법인이 없으면 별칭까지 동원해 검색한다 (예: "더존비즈온부산지사" → "더존비즈온")
  const keywords = company.saramin.length > 0
    ? [company.saramin[0]!.name]
    : [company.name, ...company.aliases];

  const wantedCsn = new Set(company.saramin.map((e) => e.csn));
  const wantedNames = new Set(
    [company.name, ...company.aliases, ...company.saramin.map((e) => e.name)].map(normalizeCompany),
  );

  for (const keyword of keywords) {
    let html: string;
    try {
      html = await fetchText(companySearchUrl(keyword));
    } catch (err) {
      log.warn(`사람인 조회 실패 (${company.name} / "${keyword}"): ${(err as Error).message}`);
      continue;
    }

    const $ = cheerio.load(html);
    const found: Posting[] = [];

    $("#company_info_list .item_corp").each((_, el) => {
      const $a = $(el).find("h2.corp_name a").first();
      const csn = /csn=([^&"]+)/.exec($a.attr("href") ?? "")?.[1];
      const name = ($a.attr("title") || $a.text()).trim();

      // 확정 csn 이 있으면 그것만 신뢰한다. 없을 때만 상호로 판단한다.
      const isOurs = wantedCsn.size > 0
        ? Boolean(csn && wantedCsn.has(csn))
        : wantedNames.has(normalizeCompany(name));
      if (!isOurs) return;

      found.push(...parseCorpBlock($, el as never, name));
    });

    if (found.length > 0) return found;
  }
  return [];
}

async function collectViaWeb(companies: Company[]): Promise<Posting[]> {
  const out: Posting[] = [];
  const seen = new Set<string>();
  for (const company of companies) {
    for (const p of await collectCompany(company)) {
      if (seen.has(p.sourceId)) continue;
      seen.add(p.sourceId);
      out.push(p);
    }
  }
  return out;
}

/* ── 공식 API 경로 (키가 있을 때 우선) ─────────────────────────── */

interface SaraminApiResponse {
  jobs?: { job?: SaraminApiJob[] };
}

interface SaraminApiJob {
  id?: string;
  url?: string;
  company?: { detail?: { name?: string } };
  position?: {
    title?: string;
    location?: { name?: string };
    "experience-level"?: { name?: string };
    "job-type"?: { name?: string };
  };
  "posting-date"?: string;
  "expiration-date"?: string;
}

async function collectViaApi(companies: Company[]): Promise<Posting[]> {
  const out: Posting[] = [];
  const seen = new Set<string>();

  for (const company of companies) {
    const keyword = company.saramin[0]?.name ?? company.name;
    const url =
      `${API_BASE}?access-key=${encodeURIComponent(config.saraminAccessKey)}` +
      `&keywords=${encodeURIComponent(keyword)}&count=50&sort=pd`;

    let res: SaraminApiResponse;
    try {
      res = await fetchJson<SaraminApiResponse>(url);
    } catch (err) {
      log.warn(`사람인 API 실패 (${company.name}): ${(err as Error).message}`);
      continue;
    }

    for (const job of res.jobs?.job ?? []) {
      const id = job.id;
      const companyRaw = job.company?.detail?.name;
      const title = job.position?.title;
      const href = job.url;
      if (!id || !companyRaw || !title || !href || seen.has(id)) continue;
      seen.add(id);
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

export async function collectSaramin(
  companies: Company[],
): Promise<{ postings: Posting[]; usedFallback: boolean }> {
  if (config.saraminAccessKey) {
    const postings = await collectViaApi(companies);
    if (postings.length > 0) return { postings, usedFallback: false };
    log.warn("사람인 API 결과 0건 — 웹 파싱으로 폴백합니다.");
  }
  return { postings: await collectViaWeb(companies), usedFallback: true };
}

export const __test = { parseCorpBlock, parseCondition };
