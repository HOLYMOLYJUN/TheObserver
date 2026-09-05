import type { Posting } from "./types.ts";

/**
 * 부산 공고를 앞에 세운다. 타지역도 알림은 보내되 카드 상단에서 먼저 보이게 한다.
 * 공고에 근무지 표기가 없으면 회사 소재지로 판단한다.
 */
export function busanFirst(postings: Posting[], regionOf: (id?: string) => string): Posting[] {
  const rank = (p: Posting) => (/부산/.test(p.location ?? regionOf(p.companyId) ?? "") ? 0 : 1);
  return [...postings].sort(
    (a, b) => rank(a) - rank(b) || a.companyRaw.localeCompare(b.companyRaw, "ko"),
  );
}
