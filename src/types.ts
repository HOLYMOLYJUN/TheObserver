/** 모든 소스가 공통으로 뱉는 채용공고 표현 */
export interface Posting {
  /** 소스 내 고유 ID. dedup 키의 원재료 */
  sourceId: string;
  source: SourceName;
  /** 소스에 표기된 회사명 (원문 그대로) */
  companyRaw: string;
  title: string;
  url: string;
  /** 매칭된 감시 대상 기업 id. 파이프라인이 채움 */
  companyId?: string;
  location?: string;
  experience?: string;
  employmentType?: string;
  /** 마감일 (원문 문자열 — 소스마다 형식이 제각각이라 파싱하지 않음) */
  deadline?: string;
  postedAt?: string;
}

export type SourceName = "saramin" | "jobkorea";

/** dedup 키. 소스가 바뀌어도 같은 공고면 같은 키가 나오도록 */
export function postingKey(p: Posting): string {
  return `${p.source}:${p.sourceId}`;
}

/** 사람인에 등록된 법인 하나. 상호가 같아도 법인이 여러 개일 수 있어 배열로 둔다. */
export interface SaraminEntity {
  /** 사람인 기업 식별자. 검색 결과의 csn 파라미터 */
  csn: string;
  /** 사람인에 표기된 상호 */
  name: string;
  /** 동명이인 법인을 구분하는 근거 */
  address: string;
}

export interface Company {
  id: string;
  name: string;
  aliases: string[];
  industry: string;
  region: string;
  /** 확정된 사람인 법인. 비어 있으면 상호 검색으로 폴백한다 */
  saramin: SaraminEntity[];
  /** 확정된 잡코리아 회사 코드. 비어 있으면 상호 검색으로 폴백한다 */
  jobkoreaCodes: string[];
}

/** 소스 하나의 수집 결과. 실패해도 파이프라인은 계속 간다 */
export interface SourceResult {
  source: SourceName;
  ok: boolean;
  postings: Posting[];
  /** 실패 사유 또는 부분 실패 경고 */
  warnings: string[];
  /** 폴백이 동작했는지 (HTTP 실패 → 브라우저 등) */
  usedFallback: boolean;
  durationMs: number;
}
