import { config } from "../config.ts";
import { log } from "../logger.ts";

/**
 * 평범한 브라우저처럼 보이는 헤더.
 * 탐지 회피 목적이 아니라, 기본 UA로는 정상 페이지를 안 주는 사이트가 있기 때문이다.
 */
const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
  "Cache-Control": "no-cache",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let lastRequestAt = 0;

/**
 * 연결 실패가 연달아 쌓이면 개별 회사 문제가 아니라 차단이다.
 * 회사마다 37초씩 재시도하며 10분을 태우는 대신 즉시 포기하고 상위에 알린다.
 */
let consecutiveConnectionFailures = 0;
const BLOCK_THRESHOLD = 3;

export class LikelyBlockedError extends Error {
  constructor(lastReason: string) {
    super(
      `연결 실패가 ${BLOCK_THRESHOLD}회 연속 발생했습니다. 차단으로 판단하고 중단합니다. (마지막 원인: ${lastReason})`,
    );
    this.name = "LikelyBlockedError";
  }
}

export function resetBlockDetector(): void {
  consecutiveConnectionFailures = 0;
}

/**
 * 요청 사이에 최소 간격을 둔다 — 서버 배려 겸, 연속 요청으로 인한 차단 방지.
 * 간격에 지터를 섞는다. 정확히 같은 주기로 두드리는 쪽이 자동화로 더 잘 보인다.
 */
async function throttle(): Promise<void> {
  const jitter = Math.floor(Math.random() * config.requestDelayMs * 0.4);
  const wait = config.requestDelayMs + jitter - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

export class HttpError extends Error {
  constructor(readonly status: number, url: string) {
    super(`HTTP ${status} — ${url}`);
    this.name = "HttpError";
  }
}

/**
 * Node 의 fetch 는 연결 단계 실패를 전부 "fetch failed" 한 줄로 감싸고
 * 진짜 이유(ECONNRESET / ENOTFOUND / 타임아웃 / TLS)는 cause 에 숨긴다.
 * 차단인지 일시적 장애인지 구분하려면 이걸 꺼내야 한다.
 */
export function describeError(err: unknown): string {
  if (err instanceof HttpError) return err.message;
  const e = err as { name?: string; message?: string; cause?: unknown };
  if (e?.name === "AbortError") return "요청 시간 초과";

  const parts = [e?.message ?? String(err)];
  let cause = e?.cause as { code?: string; message?: string; cause?: unknown } | undefined;
  for (let depth = 0; cause && depth < 3; depth++) {
    const detail = [cause.code, cause.message].filter(Boolean).join(": ");
    if (detail) parts.push(detail);
    cause = cause.cause as typeof cause;
  }
  return parts.join(" ← ");
}

interface FetchOptions {
  retries?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const { retries = 2, timeoutMs = 20_000, headers = {} } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      if (consecutiveConnectionFailures >= BLOCK_THRESHOLD) {
        throw new LikelyBlockedError("이전 요청들이 모두 연결 실패");
      }
      const res = await fetch(url, { headers: { ...HEADERS, ...headers }, signal: ac.signal });
      consecutiveConnectionFailures = 0;
      if (!res.ok) {
        // 4xx는 재시도해도 같은 결과다. 429/408만 예외.
        if (res.status < 500 && res.status !== 429 && res.status !== 408) {
          throw new HttpError(res.status, url);
        }
        throw new HttpError(res.status, url);
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (err instanceof LikelyBlockedError) throw err;
      // HTTP 응답을 받았다면 연결은 된 것이다. 연결 단계 실패만 차단 신호로 센다.
      if (!(err instanceof HttpError)) consecutiveConnectionFailures++;
      const fatal = err instanceof HttpError && err.status < 500 && err.status !== 429 && err.status !== 408;
      if (fatal || attempt === retries) break;
      const backoff = 2_000 * 2 ** attempt;
      log.warn(`요청 실패 (${attempt + 1}/${retries + 1}) ${describeError(err)} — ${backoff}ms 후 재시도`);
      await sleep(backoff);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, {
    ...opts,
    headers: { Accept: "application/json", ...opts.headers },
  });
  return JSON.parse(text) as T;
}

/**
 * Playwright 폴백. HTTP 파싱이 실패했을 때만 호출된다.
 * playwright 는 무거워서 지연 import 한다 — 브라우저가 없는 환경에서도
 * 다른 소스는 정상 동작해야 하기 때문.
 */
export async function fetchRenderedHtml(url: string, waitForSelector?: string): Promise<string> {
  if (!config.allowBrowserFallback) {
    throw new Error("브라우저 폴백이 비활성화되어 있습니다 (ALLOW_BROWSER_FALLBACK=false)");
  }
  log.warn(`브라우저 폴백 사용: ${url}`);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      userAgent: HEADERS["User-Agent"],
      locale: "ko-KR",
      viewport: { width: 1440, height: 900 },
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: 15_000 }).catch(() => {
        log.warn(`셀렉터 대기 실패(무시하고 진행): ${waitForSelector}`);
      });
    }
    return await page.content();
  } finally {
    await browser.close();
  }
}
