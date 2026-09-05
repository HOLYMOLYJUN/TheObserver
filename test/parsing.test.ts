import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as cheerio from "cheerio";
import { __test as saramin } from "../src/sources/saramin.ts";
import { parseJobkoreaHtml } from "../src/sources/jobkorea.ts";

/**
 * 사람인 픽스처는 추측이 아니라 GitHub Actions 러너가 실제로 받아온 HTML 에서
 * (주)프리그로우 법인 블록을 그대로 잘라낸 것이다.
 */
const CORP_BLOCK = readFileSync(new URL("./fixtures/saramin-corp-block.html", import.meta.url), "utf8");

function parseFixture() {
  const $ = cheerio.load(CORP_BLOCK);
  const el = $("#company_info_list .item_corp").first()[0]!;
  return saramin.parseCorpBlock($, el as never, "(주)프리그로우");
}

test("사람인 실제 마크업에서 진행중 공고를 뽑는다", () => {
  const out = parseFixture();
  assert.equal(out.length, 3);

  const first = out[0]!;
  assert.equal(first.title, "[경력] Flutter·React 풀스택 개발자 채용");
  assert.equal(first.sourceId, "54710493");
  assert.equal(first.source, "saramin");
  assert.equal(first.companyRaw, "(주)프리그로우");
  assert.equal(first.url, "https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=54710493");
});

test("근무지·경력·마감을 구분해 담는다", () => {
  const [flutter, pm] = parseFixture();

  assert.equal(flutter!.location, "부산 동구");
  assert.equal(flutter!.experience, "경력2년↑");
  assert.equal(flutter!.deadline, "~09.10(목)");
  // "학력무관" 이 경력 칸으로 새면 안 된다
  assert.notEqual(flutter!.experience, "학력무관");
  // 이 공고들엔 고용형태 표기가 없다 — 없는 걸 지어내면 안 된다
  assert.equal(flutter!.employmentType, undefined);

  assert.equal(pm!.deadline, "채용시");
});

test("사람인 조건 문자열을 항목별로 분류한다", () => {
  const r = saramin.parseCondition(["서울 강남구", "경력 3~5년", "학력무관", "정규직"]);
  assert.equal(r.location, "서울 강남구");
  assert.equal(r.experience, "경력 3~5년");
  assert.equal(r.employmentType, "정규직");
});

test("사람인: 공고 없는 법인은 0건", () => {
  const $ = cheerio.load(`<div id="company_info_list"><div class="item_corp">
    <h2 class="corp_name"><a href="/zf_user/company-info/view?csn=X" title="(주)무공고">(주)무공고</a></h2>
  </div></div>`);
  const el = $(".item_corp").first()[0]!;
  assert.equal(saramin.parseCorpBlock($, el as never, "(주)무공고").length, 0);
});

/**
 * 잡코리아는 Next.js 클라이언트 렌더링이라 서버 HTML 에 공고가 없다.
 * 아래는 브라우저가 렌더링한 뒤의 DOM 형태 — Tailwind 유틸리티 클래스라
 * 의미 있는 클래스명이 없으므로 공고 링크를 기준점으로 삼는다.
 */
test("잡코리아 렌더링 DOM 에서 공고를 뽑는다", () => {
  const html = `
    <div class="flex flex-col gap-[10px]">
      <div class="flex flex-col">
        <a href="https://www.jobkorea.co.kr/Recruit/GI_Read/49734666?Oem_Code=C1" title="프론트엔드 개발자">프론트엔드 개발자</a>
        <a href="https://www.jobkorea.co.kr/Recruit/Co_Read/C/302357">(주)씨넷</a>
        <span>부산 영도구</span><span>경력 3년↑</span><span>정규직</span><span>~10/15(수)</span>
      </div>
    </div>`;
  const out = parseJobkoreaHtml(html, "폴백회사");
  assert.equal(out.length, 1);
  const p = out[0]!;
  assert.equal(p.sourceId, "49734666");
  assert.equal(p.companyRaw, "(주)씨넷");
  assert.equal(p.location, "부산 영도구");
  assert.equal(p.experience, "경력 3년↑");
  assert.equal(p.employmentType, "정규직");
  assert.equal(p.deadline, "~10/15(수)");
});

test("잡코리아: 회사명을 못 찾으면 폴백 회사명을 쓴다", () => {
  const out = parseJobkoreaHtml(`<div><a href="/Recruit/GI_Read/111" title="백엔드">백엔드</a></div>`, "(주)토즈");
  assert.equal(out[0]!.companyRaw, "(주)토즈");
  assert.equal(out[0]!.url, "https://www.jobkorea.co.kr/Recruit/GI_Read/111");
});

test("잡코리아: 같은 공고가 여러 번 나와도 한 번만", () => {
  const a = `<a href="/Recruit/GI_Read/222" title="앱 개발자">앱</a>`;
  assert.equal(parseJobkoreaHtml(`<div>${a}${a}</div>`, "X").length, 1);
});

test("잡코리아: 공고 링크가 없으면 0건", () => {
  assert.equal(parseJobkoreaHtml(`<div><a href="/about">회사소개</a></div>`, "X").length, 0);
});
