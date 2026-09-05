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

/** 요청 사이에 최소 간격을 둔다 — 서버 배려 겸, 연속 요청으로 인한 차단 방지 */
async function throttle(): Promise<void> {
  const wait = config.requestDelayMs - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

export class HttpError extends Error {
  constructor(readonly status: number, url: string) {
    super(`HTTP ${status} — ${url}`);
    this.name = "HttpError";
  }
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
      const res = await fetch(url, { headers: { ...HEADERS, ...headers }, signal: ac.signal });
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
      const fatal = err instanceof HttpError && err.status < 500 && err.status !== 429 && err.status !== 408;
      if (fatal || attempt === retries) break;
      const backoff = 2_000 * 2 ** attempt;
      log.warn(`요청 실패 (${attempt + 1}/${retries + 1}), ${backoff}ms 후 재시도: ${url}`);
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
