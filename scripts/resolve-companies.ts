/**
 * 감시 대상 기업의 사람인/잡코리아 식별자를 찾아낸다.
 *
 * 1차 실행에서 알아낸 것:
 *   - 사람인 기업 검색은 서버 렌더링이라 HTTP 로 충분하다.
 *   - 잡코리아는 Next.js 라 검색 결과가 클라이언트 렌더링된다. 브라우저가 필수다.
 *   - 상호를 그대로 검색하면 실패하는 경우가 있다 ("(주)더존비즈온부산지사" → 0건).
 *     별칭까지 순서대로 시도해야 한다.
 *
 * 출력:
 *   debug-output/candidates.json   회사별 후보 (검수용)
 *   debug-output/html/*.html       원본 HTML (셀렉터 확정용)
 *   debug-output/summary.md        요약
 */
import { mkdir, writeFile } from "node:fs/promises";
import * as cheerio from "cheerio";
import type { Browser, Page } from "playwright";
import { loadCompanies } from "../src/companies.ts";
import { normalizeCompany } from "../src/normalize.ts";
import { fetchText } from "../src/sources/fetcher.ts";
import { log } from "../src/logger.ts";
import type { Company } from "../src/types.ts";

const OUT = "debug-output";

interface Candidate {
  name: string;
  code?: string;
  address?: string;
  jobCount?: number;
  exactMatch: boolean;
  /** 어떤 검색어로 찾았는지 — 별칭이 필요한 회사를 파악하기 위해 */
  via: string;
}

interface CompanyReport {
  id: string;
  name: string;
  region: string;
  saramin: { ok: boolean; error?: string; candidates: Candidate[] };
  jobkorea: {
    ok: boolean;
    error?: string;
    candidates: Candidate[];
    /** 검색 결과 중 상호가 실제로 일치한 공고 수 */
    ownedJobs: number;
    /** 검색 결과에 섞여 나온 무관한 회사 (광고·유사검색 확인용) */
    otherCorps: string[];
  };
}

/* ── 사람인 (HTTP) ─────────────────────────────────────────────── */

async function probeSaramin(company: Company): Promise<CompanyReport["saramin"]> {
  const target = normalizeCompany(company.name);
  const errors: string[] = [];

  // 상호 → 별칭 순으로 시도. 결과가 나오면 거기서 멈춘다.
  for (const keyword of [company.name, ...company.aliases]) {
    const url = `https://www.saramin.co.kr/zf_user/search/company?searchType=search&searchword=${encodeURIComponent(keyword)}`;
    try {
      const html = await fetchText(url);
      await writeFile(`${OUT}/html/saramin-${company.id}.http.html`, html, "utf8");

      const $ = cheerio.load(html);
      const cands: Candidate[] = [];
      $("#company_info_list .item_corp").each((_, el) => {
        const $el = $(el);
        const $a = $el.find("h2.corp_name a").first();
        const name = ($a.attr("title") || $a.text()).trim();
        const code = /csn=([^&"]+)/.exec($a.attr("href") ?? "")?.[1];
        if (!name || !code) return;

        let address = "";
        $el.find("dl").each((__, dl) => {
          if ($(dl).find("dt").text().trim() === "기업주소") address = $(dl).find("dd").text().trim();
        });

        const n = normalizeCompany(name);
        // 무관한 회사까지 담지 않도록 상호가 서로를 포함할 때만 후보로 본다
        if (!n || (!n.includes(target) && !target.includes(n))) return;

        cands.push({
          name, code, address,
          jobCount: $el.find("ul.list_ongoing > li").length,
          exactMatch: n === target,
          via: keyword,
        });
      });

      if (cands.length > 0) return { ok: true, candidates: cands.slice(0, 20) };
      errors.push(`"${keyword}" → 0건`);
    } catch (err) {
      errors.push(`"${keyword}" → ${(err as Error).message}`);
    }
  }
  return { ok: errors.length === 0, error: errors.join(" / "), candidates: [] };
}

/* ── 잡코리아 (브라우저 필수) ──────────────────────────────────── */

async function probeJobkorea(page: Page, company: Company): Promise<CompanyReport["jobkorea"]> {
  const target = normalizeCompany(company.name);
  const errors: string[] = [];

  // 기업 탭(회사 코드) 과 공고 탭(실제 공고 보유 여부) 을 모두 확인한다
  const keywords = [company.name, ...company.aliases];
  const targets = keywords.flatMap((k) => [
    { keyword: k, tab: "corp" },
    { keyword: k, tab: "recruit" },
  ]);

  for (const { keyword, tab } of targets) {
    const url = `https://www.jobkorea.co.kr/Search/?stext=${encodeURIComponent(keyword)}&tabType=${tab}`;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      // 기업 카드 또는 공고 링크 중 하나라도 뜰 때까지 기다린다
      await page
        .waitForSelector("a[href*='Co_Read'], a[href*='GI_Read']", { timeout: 12_000 })
        .catch(() => {});
      const html = await page.content();
      await writeFile(`${OUT}/html/jobkorea-${company.id}.${tab}.html`, html, "utf8");

      const $ = cheerio.load(html);

      /*
       * 잡코리아 검색은 전문 유사 검색이다. "(주)프리모엠" 검색에 두산·판타지오 공고가
       * 섞여 나오고 "(주)아이오티솔루션" 은 322건이 잡힌다. 그래서 링크 개수는 의미가
       * 없고, 공고 카드에 적힌 상호가 대상 회사와 일치하는지 세어야 한다.
       */
      let ownedJobs = 0;
      const otherCorps = new Set<string>();
      const countedJobs = new Set<string>();
      $("a[href*='GI_Read']").each((_, a) => {
        const id = /GI_Read\/(\d+)/.exec($(a).attr("href") ?? "")?.[1];
        if (!id || countedJobs.has(id)) return;
        countedJobs.add(id);
        const $card = $(a).closest("li, article, div[class*='flex-col']").first();
        const corp = $card.find("a[href*='Co_Read'], a[href*='/company/']").first().text().trim();
        const n = normalizeCompany(corp);
        if (n && (n.includes(target) || target.includes(n))) ownedJobs++;
        else if (corp) otherCorps.add(corp);
      });

      const cands: Candidate[] = [];
      const seen = new Set<string>();

      $("a[href*='Co_Read'], a[href*='/company/']").each((_, a) => {
        const href = $(a).attr("href") ?? "";
        const code = /Co_Read\/C\/(\d+)/.exec(href)?.[1] ?? /\/company\/(\d+)/.exec(href)?.[1];
        const name = ($(a).attr("title") || $(a).text()).replace(/\s+/g, " ").trim();
        if (!code || !name || name.length > 40 || seen.has(code)) return;

        const n = normalizeCompany(name);
        if (!n || (!n.includes(target) && !target.includes(n))) return;
        seen.add(code);
        cands.push({ name, code, exactMatch: n === target, via: keyword });
      });

      if (cands.length > 0 || ownedJobs > 0) {
        return {
          ok: true,
          candidates: cands.slice(0, 20),
          ownedJobs,
          otherCorps: [...otherCorps].slice(0, 5),
        };
      }
      errors.push(`"${keyword}" → 본인 공고 0건 (무관 결과 ${countedJobs.size}건)`);
    } catch (err) {
      errors.push(`"${keyword}" → ${(err as Error).message}`);
    }
  }
  return { ok: errors.length === 0, error: errors.join(" / "), candidates: [], ownedJobs: 0, otherCorps: [] };
}

/* ── 요약 ──────────────────────────────────────────────────────── */

function pick(cands: Candidate[], region: string): Candidate | undefined {
  const exact = cands.filter((c) => c.exactMatch);
  return exact.find((c) => c.address?.startsWith(region)) ?? exact[0] ?? cands[0];
}

function renderSummary(reports: CompanyReport[]): string {
  const rows = reports.map((r) => {
    const s = pick(r.saramin.candidates, r.region);
    const j = pick(r.jobkorea.candidates, r.region);
    const sTxt = s
      ? `${s.exactMatch ? "★" : "?"} ${s.name} · ${s.address?.split(" ").slice(0, 2).join(" ") ?? "-"} · 공고${s.jobCount ?? 0}`
      : `❌ ${r.saramin.error ?? "후보 없음"}`;
    const jTxt = j
      ? `${j.exactMatch ? "★" : "?"} ${j.name} (${j.code})`
      : r.jobkorea.ownedJobs > 0
        ? `기업코드 없음 · 본인 공고 ${r.jobkorea.ownedJobs}건`
        : `❌ ${r.jobkorea.error ?? "후보 없음"}`;
    return `| ${r.name} | ${sTxt} | ${jTxt} |`;
  });

  const noSaramin = reports.filter((r) => r.saramin.candidates.length === 0);
  const noJobkorea = reports.filter(
    (r) => r.jobkorea.candidates.length === 0 && r.jobkorea.ownedJobs === 0,
  );

  return [
    "# 회사 식별자 수집 결과",
    "",
    `- 대상 ${reports.length}곳`,
    `- 사람인 미해결: ${noSaramin.length}곳${noSaramin.length ? ` (${noSaramin.map((r) => r.name).join(", ")})` : ""}`,
    `- 잡코리아 미해결: ${noJobkorea.length}곳${noJobkorea.length ? ` (${noJobkorea.map((r) => r.name).join(", ")})` : ""}`,
    "",
    "★ = 상호 완전 일치 · 지역이 기대와 다르면 동명이인 법인일 수 있음",
    "",
    "| 회사 | 사람인 | 잡코리아 |",
    "|---|---|---|",
    ...rows,
    "",
    "> 전체 후보는 `candidates.json`, 원본 HTML은 `html/` 참조.",
  ].join("\n");
}

/* ── 진입점 ────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  await mkdir(`${OUT}/html`, { recursive: true });

  const all = await loadCompanies();
  const only = process.env.COMPANY_ID?.trim();
  const companies = only ? all.filter((c) => c.id === only) : all;
  if (companies.length === 0) {
    throw new Error(`COMPANY_ID="${only}" 에 해당하는 기업이 없습니다. 유효한 id: ${all.map((c) => c.id).join(", ")}`);
  }
  if (only) log.info(`${companies[0]!.name} 한 곳만 조회합니다.`);

  const { chromium } = await import("playwright");
  let browser: Browser | undefined;
  const reports: CompanyReport[] = [];

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
    await page.route("**/*", (route) =>
      ["image", "font", "media"].includes(route.request().resourceType())
        ? route.abort()
        : route.continue(),
    );

    for (const company of companies) {
      log.step(`조회: ${company.name}`);
      reports.push({
        id: company.id,
        name: company.name,
        region: company.region,
        saramin: await probeSaramin(company),
        jobkorea: await probeJobkorea(page, company),
      });
    }
  } finally {
    await browser?.close();
  }

  await writeFile(`${OUT}/candidates.json`, `${JSON.stringify(reports, null, 2)}\n`, "utf8");
  const summary = renderSummary(reports);
  await writeFile(`${OUT}/summary.md`, `${summary}\n`, "utf8");
  log.info(`완료 — ${OUT}/summary.md`);
  console.log(`\n${summary}`);
}

await main();
