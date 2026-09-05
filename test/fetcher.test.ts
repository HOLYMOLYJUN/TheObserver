import { test } from "node:test";
import assert from "node:assert/strict";
import { describeError, HttpError } from "../src/sources/fetcher.ts";

/**
 * Node 의 fetch 는 연결 실패를 "fetch failed" 한 줄로 감싸고 진짜 원인을 cause 에 숨긴다.
 * 차단(ECONNRESET)인지 DNS 문제(ENOTFOUND)인지 일시적 타임아웃인지 구분하려면 꺼내야 한다.
 */
test("fetch 실패의 실제 원인을 드러낸다", () => {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = { code: "ECONNRESET", message: "socket hang up" };

  const out = describeError(err);
  assert.match(out, /fetch failed/);
  assert.match(out, /ECONNRESET/, "차단 판단에 필요한 코드가 남아야 한다");
  assert.match(out, /socket hang up/);
});

test("중첩된 cause 도 따라간다", () => {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = {
    code: "UND_ERR_CONNECT_TIMEOUT",
    message: "Connect Timeout Error",
    cause: { code: "ETIMEDOUT" },
  };
  assert.match(describeError(err), /UND_ERR_CONNECT_TIMEOUT.*ETIMEDOUT/s);
});

test("HTTP 상태 오류는 그대로 읽힌다", () => {
  assert.equal(describeError(new HttpError(403, "https://example.com")), "HTTP 403 — https://example.com");
});

test("타임아웃 중단은 별도로 표기한다", () => {
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  assert.equal(describeError(err), "요청 시간 초과");
});

test("cause 가 없어도 메시지는 남는다", () => {
  assert.equal(describeError(new Error("무언가 잘못됨")), "무언가 잘못됨");
});
