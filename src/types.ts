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

export interface Company {
  id: string;
  name: string;
  aliases: string[];
  industry: string;
  region: string;
  /** 사람인에 실제로 표기되는 회사명. resolve-companies 로 확정 */
  saraminName: string | null;
  /** 잡코리아 회사 코드 (/company/{code}/Recruit). resolve-companies 로 확정 */
  jobkoreaCode: string | null;
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
