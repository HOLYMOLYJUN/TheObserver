import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJobkoreaHtml } from "../src/sources/jobkorea.ts";

/**
 * 실제 잡코리아 마크업은 resolve-companies 아티팩트로 확정한다.
 * 여기서는 우리 파서의 배관 — ID 추출 / 중복 제거 / 컨테이너 미발견 시 폴백 — 을 검증한다.
 */

test("목록 컨테이너에서 공고를 추출한다", () => {
  const html = `
    <ul>
      <li class="list-post">
        <div class="post-list-info">
          <a class="title" href="/Recruit/GI_Read/46512345" title="프론트엔드 개발자 (React)">프론트엔드 개발자</a>
        </div>
        <div class="post-list-corp"><a href="/company/123">(주)에스위너스</a></div>
        <div class="option"><span>경력 3년↑</span><span>부산 해운대구</span><span>정규직</span></div>
        <span class="date">~09/30(화)</span>
      </li>
      <li class="list-post">
        <div class="post-list-info">
          <a class="title" href="https://www.jobkorea.co.kr/Recruit/GI_Read/46599999">백엔드 신입</a>
        </div>
        <div class="post-list-corp"><a href="/company/456">(주)토즈</a></div>
      </li>
    </ul>`;

  const out = parseJobkoreaHtml(html);
  assert.equal(out.length, 2);

  const [first, second] = out;
  assert.equal(first!.sourceId, "46512345");
  assert.equal(first!.title, "프론트엔드 개발자 (React)"); // title 속성을 우선한다
  assert.equal(first!.companyRaw, "(주)에스위너스");
  assert.equal(first!.url, "https://www.jobkorea.co.kr/Recruit/GI_Read/46512345"); // 상대경로 보정
  assert.equal(first!.experience, "경력 3년↑");
  assert.equal(first!.employmentType, "정규직");
  assert.equal(first!.source, "jobkorea");

  assert.equal(second!.sourceId, "46599999");
  assert.equal(second!.url, "https://www.jobkorea.co.kr/Recruit/GI_Read/46599999"); // 절대경로는 그대로
});

test("같은 공고가 두 번 나와도 한 번만 담는다", () => {
  const item = `<li class="list-post">
      <a class="title" href="/Recruit/GI_Read/111">중복 공고</a>
      <div class="post-list-corp"><a href="/company/1">(주)토즈</a></div>
    </li>`;
  assert.equal(parseJobkoreaHtml(`<ul>${item}${item}</ul>`).length, 1);
});

test("컨테이너를 못 찾으면 공고 링크라도 긁는다", () => {
  // 사이트 개편으로 셀렉터가 전부 깨진 상황. 0건보다는 링크라도 건지는 게 낫다.
  const html = `
    <div class="완전히-새로운-클래스명">
      <a href="/Recruit/GI_Read/77777777">웹 퍼블리셔 모집</a>
      <a href="/Recruit/GI_Read/88888888" title="앱 개발자">앱</a>
      <a href="/about">회사소개</a>
    </div>`;

  const out = parseJobkoreaHtml(html, "(주)프리모엠");
  assert.equal(out.length, 2, "공고 링크 2건만 잡혀야 한다");
  assert.equal(out[0]!.sourceId, "77777777");
  assert.equal(out[0]!.companyRaw, "(주)프리모엠", "폴백 회사명이 채워져야 한다");
  assert.equal(out[1]!.title, "앱 개발자");
});

test("공고가 없는 페이지는 0건을 반환한다", () => {
  assert.equal(parseJobkoreaHtml("<div><p>검색 결과가 없습니다</p></div>").length, 0);
});
