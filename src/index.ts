import { config, assertConfig } from "./config.ts";
import { log } from "./logger.ts";
import { loadCompanies, buildIndex, matchCompany } from "./companies.ts";
import { isDevRole } from "./keywords.ts";
import { collectAll } from "./sources/index.ts";
import { Store } from "./store.ts";
import { sendPostings, sendHeartbeat, sendBootstrapNotice, sendError } from "./slack.ts";
import type { Posting } from "./types.ts";

async function run(): Promise<void> {
  assertConfig();

  const companies = await loadCompanies();
  const index = buildIndex(companies);
  const store = await Store.load();
  log.info(`감시 기업 ${companies.length}곳 · 기록된 공고 ${store.size}건`);

  const unresolved = companies.filter((c) => !c.jobkoreaCode).length;
  if (unresolved > 0) {
    log.warn(`잡코리아 회사코드 미확정 ${unresolved}곳 — 검색 기반으로 조회합니다. ` +
      `(resolve-companies 워크플로를 실행하면 정확도가 올라갑니다)`);
  }

  /* 1. 수집 — 소스별 독립 실행 */
  const results = await collectAll(companies);
  const warnings = results.flatMap((r) => r.warnings);
  const raw = results.flatMap((r) => r.postings);
  log.info(`총 ${raw.length}건 수집`);

  /* 2. 감시 대상 기업 매칭 */
  const matched: Posting[] = [];
  for (const p of raw) {
    const companyId = matchCompany(p.companyRaw, index);
    if (companyId) matched.push({ ...p, companyId });
  }
  log.info(`대상 기업 매칭: ${matched.length}건`);

  /* 3. 개발 직무 필터 */
  const relevant = config.noDevFilter
    ? matched
    : matched.filter((p) => isDevRole(p.title, p.employmentType ?? ""));
  const filteredOut = matched.length - relevant.length;
  log.info(`개발 직무 필터 통과: ${relevant.length}건 (제외 ${filteredOut}건)`);

  /* 4. 중복 제거 */
  const fresh = store.filterNew(relevant);
  log.info(`신규 공고: ${fresh.length}건`);

  /* 5. 발송 */
  const companyName = (id?: string) => (id ? index.byId.get(id)?.name ?? "" : "");

  // 수집이 통째로 실패한 회차에 부트스트랩을 완료 처리하면,
  // 다음 성공 회차에서 기존 공고 전부가 "신규"로 터진다. 그래서 수집 성공을 전제로 한다.
  const collectionSucceeded = results.some((r) => r.ok && r.postings.length > 0);

  if (!store.isBootstrapped && !collectionSucceeded) {
    log.warn("수집 실패로 부트스트랩을 보류합니다 — 다음 성공 실행에서 재시도합니다.");
  } else if (!store.isBootstrapped) {
    // 최초 실행: 기존 공고를 조용히 등록만 하고 요약 한 건만 보낸다
    log.step("부트스트랩 — 기존 공고를 알림 없이 등록합니다");
    store.record(fresh);
    store.markBootstrapped();
    await sendBootstrapNotice(fresh.length, companies.length);
  } else if (fresh.length > 0) {
    await sendPostings(fresh, companyName, warnings);
    // 발송 성공 후에 기록한다 — 실패 시 다음 실행에서 재시도되도록
    store.record(fresh.slice(0, config.maxCards));
    log.info(`Slack 발송 완료: ${Math.min(fresh.length, config.maxCards)}건`);
  } else {
    const isHeartbeatDay = new Date().getUTCDay() === config.heartbeatDow;
    // KST 09시 실행 = UTC 00시. 오전 실행에만 하트비트를 보낸다.
    const isMorningRun = new Date().getUTCHours() < 4;
    if (config.heartbeatDow >= 0 && isHeartbeatDay && isMorningRun) {
      await sendHeartbeat(companies.length, results, store.size);
      log.info("하트비트 발송");
    } else {
      log.info("신규 공고 없음 — 발송 생략");
    }
  }

  /* 6. 상태 저장 */
  const pruned = store.prune();
  if (pruned > 0) log.info(`오래된 기록 ${pruned}건 정리`);
  await store.save();

  /* 7. 수집이 전부 실패했으면 워크플로를 실패로 표시한다 */
  if (results.every((r) => !r.ok || r.postings.length === 0)) {
    throw new Error(
      `모든 소스에서 공고를 가져오지 못했습니다. 차단 또는 셀렉터 변경 의심.\n${warnings.join("\n")}`,
    );
  }
  for (const w of warnings) log.warn(w);
}

try {
  await run();
  log.info("완료");
} catch (err) {
  log.error("실행 실패:", err);
  await sendError(err);
  process.exitCode = 1;
}
