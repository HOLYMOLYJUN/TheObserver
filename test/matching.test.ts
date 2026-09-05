import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCompany, stripBranch } from "../src/normalize.ts";
import { buildIndex, matchCompany } from "../src/companies.ts";
import { isDevRole } from "../src/keywords.ts";
import type { Company } from "../src/types.ts";

const c = (id: string, name: string, aliases: string[] = []): Company => ({
  id, name, aliases, industry: "", region: "", saraminName: null, jobkoreaCode: null,
});

test("법인격 표기를 걷어낸다", () => {
  assert.equal(normalizeCompany("(주)에스위너스"), "에스위너스");
  assert.equal(normalizeCompany("헨켈코리아(유)"), "헨켈코리아");
  assert.equal(normalizeCompany("일주지앤에스(주)"), "일주지앤에스");
  assert.equal(normalizeCompany("주식회사 토즈"), "토즈");
  assert.equal(normalizeCompany("BNK 시스템"), "bnk시스템");
  assert.equal(normalizeCompany("Henkel Korea Co., Ltd."), "henkelkorea");
});

test("지사 접미어를 떼어낸다", () => {
  assert.equal(stripBranch("더존비즈온부산지사"), "더존비즈온");
  assert.equal(stripBranch("카카오제주본사"), "카카오제주본사"); // 본사는 목록에 없음 → 유지
  assert.equal(stripBranch("삼성서울연구소"), "삼성");
});

test("표기가 달라도 같은 회사로 매칭된다", () => {
  const idx = buildIndex([
    c("douzone_bs", "(주)더존비즈온부산지사", ["더존비즈온"]),
    c("swinnus", "(주)에스위너스", ["Swinnus"]),
    c("kamco", "한국자산관리공사", ["캠코", "KAMCO"]),
  ]);

  assert.equal(matchCompany("(주)더존비즈온부산지사", idx), "douzone_bs");
  assert.equal(matchCompany("더존비즈온 부산지사", idx), "douzone_bs");
  assert.equal(matchCompany("주식회사 더존비즈온", idx), "douzone_bs");
  assert.equal(matchCompany("에스위너스", idx), "swinnus");
  assert.equal(matchCompany("SWINNUS", idx), "swinnus");
  assert.equal(matchCompany("캠코", idx), "kamco");
});

test("무관한 회사는 매칭되지 않는다", () => {
  const idx = buildIndex([c("toz", "(주)토즈", ["TOZ"])]);
  assert.equal(matchCompany("네이버", idx), null);
  assert.equal(matchCompany("카카오엔터프라이즈", idx), null);
});

test("개발 직무를 통과시킨다", () => {
  for (const title of [
    "프론트엔드 개발자 (React)",
    "백엔드 신입 채용",
    "웹 퍼블리셔 모집",
    "Android 앱 개발자",
    "풀스택 엔지니어",
    "서비스 기획자 (웹/앱)",
    "Java Spring 서버 개발",
    "IT 기획 담당자",
  ]) {
    assert.equal(isDevRole(title), true, `통과했어야 함: ${title}`);
  }
});

test("개발과 무관한 직무는 걸러낸다", () => {
  for (const title of [
    "영업기획 담당자",
    "전략기획팀 신입",
    "생산직 사원 모집",
    "간호조무사 채용",
    "회계 경력직",
    "마케팅 기획 매니저",
  ]) {
    assert.equal(isDevRole(title), false, `걸러졌어야 함: ${title}`);
  }
});
