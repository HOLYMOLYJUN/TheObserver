import { log } from "./logger.ts";

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function int(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const config = {
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL ?? "",
  saraminAccessKey: process.env.SARAMIN_ACCESS_KEY ?? "",

  /** true면 Slack으로 보내지 않고 콘솔에만 출력 */
  dryRun: bool("DRY_RUN", false),
  /** true면 개발 직무 필터를 끄고 모든 공고를 통과시킴 */
  noDevFilter: bool("NO_DEV_FILTER", false),
  /** 1회 실행당 개별 카드 발송 상한. 초과분은 요약 한 줄로 */
  maxCards: int("MAX_CARDS", 20),
  /** seen.json 보관 기간 */
  retentionDays: int("RETENTION_DAYS", 90),
  /** 소스 요청 간 최소 간격 (ms). 상대 서버 배려 겸 차단 회피 */
  requestDelayMs: int("REQUEST_DELAY_MS", 1500),
  /** HTTP 실패 시 Playwright 폴백 허용 여부 */
  allowBrowserFallback: bool("ALLOW_BROWSER_FALLBACK", true),
  /** 하트비트를 보낼 요일 (0=일 … 1=월). -1이면 비활성 */
  heartbeatDow: Number(process.env.HEARTBEAT_DOW ?? "1"),
} as const;

export function assertConfig(): void {
  if (!config.slackWebhookUrl && !config.dryRun) {
    throw new Error("SLACK_WEBHOOK_URL 이 설정되지 않았습니다. (또는 DRY_RUN=true 로 실행)");
  }
  if (!config.saraminAccessKey) {
    log.warn("SARAMIN_ACCESS_KEY 없음 — 사람인은 공식 API 대신 웹 파싱으로 동작합니다.");
  }
}
