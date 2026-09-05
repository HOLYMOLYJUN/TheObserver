/**
 * 개발 직군 판별.
 * 대상: 웹 / 기획 / 앱 / 프론트 / 백 / 풀스택 등 개발 관련 전부.
 */

const INCLUDE = [
  // 직군
  "개발", "developer", "engineer", "엔지니어", "프로그래머", "programmer",
  "프론트", "프론트엔드", "frontend", "front-end", "front end",
  "백엔드", "backend", "back-end", "back end", "서버",
  "풀스택", "fullstack", "full-stack", "full stack",
  "웹", "web", "퍼블리셔", "퍼블리싱", "publisher",
  "앱", "app", "모바일", "mobile", "안드로이드", "android", "ios",
  "소프트웨어", "software", "sw", "시스템", "솔루션", "응용프로그램",
  "devops", "데브옵스", "인프라", "infra", "sre", "클라우드", "cloud",
  "데이터엔지니어", "데이터 엔지니어", "data engineer",
  "임베디드", "embedded", "펌웨어", "firmware",
  // 기획 (사용자 요청: 웹/서비스 기획 포함)
  "서비스기획", "서비스 기획", "웹기획", "웹 기획", "it기획", "it 기획",
  "프로덕트", "product manager", "product owner", "pm", "po", "기획자",
  // 기술 스택
  "react", "리액트", "vue", "뷰", "angular", "next.js", "nextjs", "svelte",
  "typescript", "javascript", "자바스크립트", "node", "node.js", "nodejs",
  "java", "자바", "spring", "스프링", "python", "파이썬", "django",
  "kotlin", "코틀린", "swift", "스위프트", "flutter", "플러터",
  "php", "c#", ".net", "golang", "rust", "sql", "aws",
];

/**
 * INCLUDE 에 걸렸어도 개발 직무가 아닌 게 확실한 것들.
 * "기획", "pm" 같은 넓은 키워드가 영업/마케팅 공고를 끌어오는 걸 막는다.
 */
const EXCLUDE = [
  "영업기획", "영업 기획", "전략기획", "전략 기획", "경영기획", "경영 기획",
  "마케팅기획", "마케팅 기획", "재무기획", "홍보기획", "광고기획", "행사기획",
  "생산기획", "구매기획", "인사기획", "총무", "회계", "세무", "노무",
  "영업관리", "영업직", "세일즈", "sales", "텔레마케팅", "cs상담", "고객상담",
  "간호", "요양", "조리", "운전", "배송", "물류센터", "생산직", "제조직",
  "건축설계", "토목", "기계설계", "전기설비", "시공", "감리",
  // 디자인 직군은 요청 범위(웹/기획/앱/프론트/백/풀스택)에 없다.
  // "디자이너" 를 통째로 막으면 "웹디자이너/퍼블리셔" 같은 공고까지 놓치므로
  // 개발이 아닌 것이 분명한 조합만 제외한다.
  "프로덕트디자이너", "프로덕트 디자이너", "product designer",
  "ui디자이너", "ux디자이너", "ui/ux디자이너", "그래픽디자이너", "브랜드디자이너",
  "영상디자이너", "편집디자이너", "패키지디자이너", "공간디자이너", "제품디자이너",
];

const lower = (s: string) => s.normalize("NFKC").toLowerCase();

export function isDevRole(title: string, extra = ""): boolean {
  const text = lower(`${title} ${extra}`);
  if (EXCLUDE.some((k) => text.includes(lower(k)))) return false;
  return INCLUDE.some((k) => text.includes(lower(k)));
}

/** 필터 튜닝용 — 어떤 키워드 때문에 걸렸는지 */
export function matchedKeywords(title: string, extra = ""): string[] {
  const text = lower(`${title} ${extra}`);
  return INCLUDE.filter((k) => text.includes(lower(k)));
}
