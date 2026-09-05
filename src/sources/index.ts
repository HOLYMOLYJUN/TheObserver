import type { Company, SourceResult, SourceName } from "../types.ts";
import { log } from "../logger.ts";
import { collectSaramin } from "./saramin.ts";
import { collectJobkorea } from "./jobkorea.ts";

type Collector = (companies: Company[]) => Promise<{ postings: import("../types.ts").Posting[]; usedFallback: boolean }>;

const SOURCES: Record<SourceName, Collector> = {
  saramin: collectSaramin,
  jobkorea: collectJobkorea,
};

/**
 * 모든 소스를 돌린다. **하나가 실패해도 나머지는 계속 간다** —
 * 잡코리아가 막혔다고 사람인 알림까지 죽으면 안 되기 때문.
 */
export async function collectAll(companies: Company[]): Promise<SourceResult[]> {
  const results: SourceResult[] = [];

  for (const [name, collect] of Object.entries(SOURCES) as [SourceName, Collector][]) {
    const started = Date.now();
    log.step(`${name} 수집 시작`);
    try {
      const { postings, usedFallback } = await collect(companies);
      const warnings = postings.length === 0 ? [`${name}: 수집 결과 0건 (셀렉터 변경 또는 차단 의심)`] : [];
      log.info(`${name} 수집 완료: ${postings.length}건${usedFallback ? " (폴백 사용)" : ""}`);
      results.push({ source: name, ok: true, postings, warnings, usedFallback, durationMs: Date.now() - started });
    } catch (err) {
      const msg = (err as Error).message;
      log.error(`${name} 수집 실패: ${msg}`);
      results.push({
        source: name,
        ok: false,
        postings: [],
        warnings: [`${name}: 수집 실패 — ${msg}`],
        usedFallback: false,
        durationMs: Date.now() - started,
      });
    }
  }

  return results;
}
