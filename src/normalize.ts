/**
 * 회사명 정규화.
 * 잡플래닛/사람인/잡코리아가 같은 회사를 서로 다르게 표기하는 걸 흡수한다.
 *   "(주)더존비즈온부산지사" → "더존비즈온부산지사"
 *   "헨켈코리아(유)"         → "헨켈코리아"
 *   "BNK 시스템"             → "bnk시스템"
 */
const LEGAL_FORMS = [
  "주식회사", "유한회사", "유한책임회사", "합자회사", "합명회사",
  "재단법인", "사단법인", "의료법인", "학교법인",
  "\\(주\\)", "\\(유\\)", "\\(재\\)", "\\(사\\)", "\\(합\\)", "\\(株\\)",
  "㈜", "㈐", "co\\.,?\\s*ltd\\.?", "corp\\.?", "inc\\.?", "ltd\\.?", "llc",
];

const LEGAL_RE = new RegExp(LEGAL_FORMS.join("|"), "gi");

export function normalizeCompany(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(LEGAL_RE, "")
    // 괄호로 감싼 부연 설명 제거: "카카오(판교)" → "카카오"
    .replace(/\([^)]*\)/g, "")
    .replace(/[\s​·・.,'"`\-_/\\]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * 지사/지점 접미어까지 떼어낸 더 느슨한 형태.
 * "더존비즈온부산지사" → "더존비즈온"
 * 오탐 위험이 있어 정확 매칭이 실패했을 때만 쓴다.
 */
const BRANCH_RE = /(부산|서울|인천|대구|대전|광주|울산|경기|충남|충북|전남|전북|경남|경북|강원|제주)?(지사|지점|사업부|사업본부|본부|센터|연구소|법인)$/;

export function stripBranch(normalized: string): string {
  let out = normalized;
  // "부산지사" 처럼 두 겹으로 붙는 경우가 있어 반복 제거
  for (let i = 0; i < 3; i++) {
    const next = out.replace(BRANCH_RE, "");
    if (next === out) break;
    out = next;
  }
  return out;
}
