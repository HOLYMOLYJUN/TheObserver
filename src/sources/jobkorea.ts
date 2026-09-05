import * as cheerio from "cheerio";
import type { Browser, Page } from "playwright";
import type { Company, Posting } from "../types.ts";
import { config } from "../config.ts";
import { log } from "../logger.ts";
import { normalizeCompany } from "../normalize.ts";

const ORIGIN = "https://www.jobkorea.co.kr";
const JOB_LINK = "a[href*='GI_Read']";

/**
 * 잡코리아는 Next.js 로 재구축되어 검색 결과 목록이 클라이언트 렌더링된다.
 * HTTP 응답 HTML 에는 <title> 의 "총 N건" 만 있고 공고 링크는 들어있지 않아,
 * 사람인과 달리 헤드리스 브라우저가 필수다.
 *
 * 회사마다 브라우저를 새로 띄우면 회사당 40초씩 걸리므로,
 * 브라우저 하나를 열어 페이지만 갈아끼우며 전부 순회한다.
 */
function companyRecruitUrl(code: string): string {
  return `${ORIGIN}/company/${encodeURIComponent(code)}/Recruit`;
}

function searchUrl(keyword: string): string {
  return `${ORIGIN}/Search/?stext=${encodeURIComponent(keyword)}&tabType=recruit`;
}

function extractPostingId(href: string): string | null {
  return /GI_Read\/(\d+)/.exec(href)?.[1] ?? null;
}

/**
 * 렌더링된 DOM 에서 공고를 뽑는다.
 * 잡코리아가 Tailwind 유틸리티 클래스를 쓰기 때문에 의미 있는 클래스명에
 * 기댈 수 없다. 공고 링크를 기준점으로 삼고 주변 텍스트에서 정보를 줍는다.
 */
export function parseJobkoreaHtml(html: string, fallbackCompany: string): Posting[] {
  const $ = cheerio.load(html);
  const out: Posting[] = [];
  const seen = new Set<string>();

  $(JOB_LINK).each((_, a) => {
    const $a = $(a);
    const href = $a.attr("href") ?? "";
    const id = extractPostingId(href);
    const title = ($a.attr("title") || $a.text() || "").replace(/\s+/g, " ").trim();
    if (!id || !title || seen.has(id)) return;
    seen.add(id);

    // 공고 카드로 볼 만한 조상 노드까지 올라가 부가 정보를 찾는다
    const $card = $a.closest("li, article, div[class*='flex-col']").first();
    const texts = $card
      .find("span, em, p")
      .map((__, s) => $(s).text().replace(/\s+/g, " ").trim())
      .get()
      .filter((t) => t && t.length < 30);

    const companyRaw = $card.find("a[href*='Co_Read'], a[href*='/company/']").first().text().trim();

    out.push({
      sourceId: id,
      source: "jobkorea",
      companyRaw: companyRaw || fallbackCompany,
      title,
      url: href.startsWith("http") ? href : `${ORIGIN}${href}`,
      location: texts.find((t) => /^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충[북남]|전[북남]|경[북남]|제주)/.test(t)),
      experience: texts.find((t) => /경력|신입/.test(t)),
      employmentType: texts.find((t) => /정규|계약|인턴|파견|프리랜서/.test(t)),
      deadline: texts.find((t) => /^~|마감|D-\d+|오늘마감|상시/.test(t)),
    });
  });

  return out;
}

/** 목록이 렌더링될 때까지 기다린 뒤 HTML 을 돌려준다 */
async function renderedHtml(page: Page, url: string): Promise<string> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  // 공고가 0건인 회사도 있으므로, 안 나타나도 실패로 보지 않는다
  await page.waitForSelector(JOB_LINK, { timeout: 12_000 }).catch(() => {});
  return page.content();
}

async function collectCompany(page: Page, company: Company): Promise<Posting[]> {
  const urls = company.jobkoreaCodes.length > 0
    ? company.jobkoreaCodes.map(companyRecruitUrl)
    : [searchUrl(company.name)];

  const wantedNames = new Set(
    [company.name, ...company.aliases, ...company.saramin.map((e) => e.name)].map(normalizeCompany),
  );

  const out: Posting[] = [];
  const seen = new Set<string>();

  for (const url of urls) {
    let postings: Posting[];
    try {
      postings = parseJobkoreaHtml(await renderedHtml(page, url), company.name);
    } catch (err) {
      log.warn(`잡코리아 조회 실패 (${company.name}): ${(err as Error).message}`);
      continue;
    }

    for (const p of postings) {
      // 회사 코드로 들어갔으면 그 회사 공고가 맞다. 검색으로 들어갔으면 상호를 확인한다.
      if (company.jobkoreaCodes.length === 0) {
        const n = normalizeCompany(p.companyRaw);
        if (!n || !wantedNames.has(n)) continue;
      }
      if (seen.has(p.sourceId)) continue;
      seen.add(p.sourceId);
      out.push(p);
    }
  }
  return out;
}

export async function collectJobkorea(
  companies: Company[],
): Promise<{ postings: Posting[]; usedFallback: boolean }> {
  if (!config.allowBrowserFallback) {
    throw new Error(
      "잡코리아는 클라이언트 렌더링이라 브라우저가 필요합니다 (ALLOW_BROWSER_FALLBACK=false 로 비활성됨)",
    );
  }

  const { chromium } = await import("playwright");
  let browser: Browser | undefined;
  const all: Posting[] = [];

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      locale: "ko-KR",
      viewport: { width: 1440, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    // 이미지/폰트/광고는 목록 파싱에 불필요하다. 막으면 회사당 수 초씩 줄어든다.
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      return ["image", "font", "media"].includes(type) ? route.abort() : route.continue();
    });

    for (const company of companies) {
      const found = await collectCompany(page, company);
      log.info(`  잡코리아 ${company.name}: ${found.length}건`);
      all.push(...found);
      await page.waitForTimeout(config.requestDelayMs);
    }
  } finally {
    await browser?.close();
  }

  return { postings: all, usedFallback: true };
}
