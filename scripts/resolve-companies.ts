/**
 * 감시 대상 기업의 사람인/잡코리아 식별자를 찾아낸다.
 *
 * 이 세션의 개발 환경에서는 두 사이트가 네트워크 정책으로 차단되어 있어
 * 직접 조회가 불가능하다. 그래서 GitHub Actions 러너에서 한 번 돌려
 * 결과를 아티팩트로 받아 companies.json 을 확정하는 방식을 쓴다.
 *
 * 출력:
 *   debug-output/candidates.json   회사별 후보 목록 (사람 눈으로 검수)
 *   debug-output/html/*.html       원본 HTML (셀렉터 확정용)
 *   debug-output/summary.md        한눈에 보는 요약
 */
import { mkdir, writeFile } from "node:fs/promises";
import * as cheerio from "cheerio";
import { loadCompanies } from "../src/companies.ts";
import { normalizeCompany } from "../src/normalize.ts";
import { fetchText, fetchRenderedHtml } from "../src/sources/fetcher.ts";
import { log } from "../src/logger.ts";
import type { Company } from "../src/types.ts";

const OUT = "debug-output";

interface Candidate {
  name: string;
  code?: string;
  url?: string;
  /** 정규화 후 대상 기업명과 완전히 일치하는가 */
  exactMatch: boolean;
}

interface CompanyReport {
  id: string;
  name: string;
  saramin: { ok: boolean; error?: string; candidates: Candidate[] };
  jobkorea: { ok: boolean; error?: string; candidates: Candidate[] };
}

/** HTTP → 실패 시 브라우저. 두 경로 모두의 결과를 파일로 남긴다. */
async function grab(url: string, slug: string): Promise<string> {
  let html: string;
  try {
    html = await fetchText(url);
    await writeFile(`${OUT}/html/${slug}.http.html`, html, "utf8");
    return html;
  } catch (err) {
    log.warn(`HTTP 실패, 브라우저로 재시도: ${url} — ${(err as Error).message}`);
    html = await fetchRenderedHtml(url);
    await writeFile(`${OUT}/html/${slug}.browser.html`, html, "utf8");
    return html;
  }
}

function dedupe(cands: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return cands.filter((c) => {
    const key = c.code ?? c.name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function probeSaramin(company: Company): Promise<CompanyReport["saramin"]> {
  const url = `https://www.saramin.co.kr/zf_user/search/company?searchType=search&searchword=${encodeURIComponent(company.name)}`;
  try {
    const html = await grab(url, `saramin-${company.id}`);
    const $ = cheerio.load(html);
    const target = normalizeCompany(company.name);
    const cands: Candidate[] = [];

    // 회사명이 들어간 링크를 폭넓게 수집한다. 정확한 셀렉터는 이 HTML을 보고 확정.
    $("a").each((_, a) => {
      const text = $(a).text().trim();
      const href = $(a).attr("href") ?? "";
      if (!text || text.length > 40) return;
      const n = normalizeCompany(text);
      if (!n || (!n.includes(target) && !target.includes(n))) return;
      cands.push({
        name: text,
        code: /csn=([^&]+)/.exec(href)?.[1],
        url: href.startsWith("http") ? href : `https://www.saramin.co.kr${href}`,
        exactMatch: n === target,
      });
    });

    return { ok: true, candidates: dedupe(cands).slice(0, 10) };
  } catch (err) {
    return { ok: false, error: (err as Error).message, candidates: [] };
  }
}

async function probeJobkorea(company: Company): Promise<CompanyReport["jobkorea"]> {
  const url = `https://www.jobkorea.co.kr/Search/?stext=${encodeURIComponent(company.name)}&tabType=corp`;
  try {
    const html = await grab(url, `jobkorea-${company.id}`);
    const $ = cheerio.load(html);
    const target = normalizeCompany(company.name);
    const cands: Candidate[] = [];

    $("a").each((_, a) => {
      const text = $(a).text().trim();
      const href = $(a).attr("href") ?? "";
      if (!text || text.length > 40) return;
      // 잡코리아 회사 페이지 URL: /company/{code} 또는 /Recruit/Co_Read/C/{code}
      const code = /\/company\/(\d+)/.exec(href)?.[1] ?? /Co_Read\/C\/(\d+)/.exec(href)?.[1];
      if (!code) return;
      const n = normalizeCompany(text);
      if (!n || (!n.includes(target) && !target.includes(n))) return;
      cands.push({
        name: text,
        code,
        url: `https://www.jobkorea.co.kr/company/${code}/Recruit`,
        exactMatch: n === target,
      });
    });

    return { ok: true, candidates: dedupe(cands).slice(0, 10) };
  } catch (err) {
    return { ok: false, error: (err as Error).message, candidates: [] };
  }
}

function renderSummary(reports: CompanyReport[]): string {
  const rows = reports.map((r) => {
    const s = r.saramin.ok ? (r.saramin.candidates[0]?.name ?? "— 후보 없음") : `❌ ${r.saramin.error}`;
    const j = r.jobkorea.ok
      ? (r.jobkorea.candidates[0] ? `${r.jobkorea.candidates[0].name} (${r.jobkorea.candidates[0].code})` : "— 후보 없음")
      : `❌ ${r.jobkorea.error}`;
    return `| ${r.name} | ${s} | ${j} |`;
  });

  const failed = reports.filter((r) => !r.saramin.ok || !r.jobkorea.ok).length;
  const noCands = reports.filter(
    (r) => r.saramin.candidates.length === 0 && r.jobkorea.candidates.length === 0,
  ).length;

  return [
    "# 회사 식별자 수집 결과",
    "",
    `- 대상 ${reports.length}곳`,
    `- 조회 실패: ${failed}곳`,
    `- 양쪽 모두 후보 없음: ${noCands}곳`,
    "",
    "| 회사 | 사람인 최상위 후보 | 잡코리아 최상위 후보 (코드) |",
    "|---|---|---|",
    ...rows,
    "",
    "> 전체 후보는 `candidates.json`, 원본 HTML은 `html/` 참조.",
  ].join("\n");
}

async function main(): Promise<void> {
  await mkdir(`${OUT}/html`, { recursive: true });
  const all = await loadCompanies();
  const only = process.env.COMPANY_ID?.trim();
  const companies = only ? all.filter((c) => c.id === only) : all;
  if (companies.length === 0) {
    throw new Error(`COMPANY_ID="${only}" 에 해당하는 기업이 없습니다. 유효한 id: ${all.map((c) => c.id).join(", ")}`);
  }
  if (only) log.info(`${companies[0]!.name} 한 곳만 조회합니다.`);
  const reports: CompanyReport[] = [];

  for (const company of companies) {
    log.step(`조회: ${company.name}`);
    reports.push({
      id: company.id,
      name: company.name,
      saramin: await probeSaramin(company),
      jobkorea: await probeJobkorea(company),
    });
  }

  await writeFile(`${OUT}/candidates.json`, `${JSON.stringify(reports, null, 2)}\n`, "utf8");
  await writeFile(`${OUT}/summary.md`, `${renderSummary(reports)}\n`, "utf8");
  log.info(`완료 — ${OUT}/summary.md 확인`);
  console.log(`\n${renderSummary(reports)}`);
}

await main();
