import { readFile } from "node:fs/promises";
import type { Company } from "./types.ts";
import { normalizeCompany, stripBranch } from "./normalize.ts";

const DATA_PATH = new URL("../data/companies.json", import.meta.url);

let cache: Company[] | null = null;

export async function loadCompanies(): Promise<Company[]> {
  if (cache) return cache;
  const raw = await readFile(DATA_PATH, "utf8");
  const parsed = JSON.parse(raw) as { companies: Company[] };
  if (!Array.isArray(parsed.companies) || parsed.companies.length === 0) {
    throw new Error("data/companies.json 에 감시 대상 기업이 없습니다.");
  }
  cache = parsed.companies;
  return cache;
}

/** 정규화된 표기 → 회사 id 조회 테이블 */
export interface CompanyIndex {
  exact: Map<string, string>;
  loose: Map<string, string>;
  byId: Map<string, Company>;
}

/** csn → 회사 id. 확정된 법인은 이름 매칭을 건너뛰고 바로 특정할 수 있다. */
export function buildCsnIndex(companies: Company[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of companies) for (const e of c.saramin) m.set(e.csn, c.id);
  return m;
}

export function buildIndex(companies: Company[]): CompanyIndex {
  const exact = new Map<string, string>();
  const loose = new Map<string, string>();
  const byId = new Map<string, Company>();

  for (const c of companies) {
    byId.set(c.id, c);
    const forms = [c.name, ...c.aliases, ...c.saramin.map((e) => e.name)].filter(Boolean);
    for (const form of forms) {
      const n = normalizeCompany(form);
      if (!n) continue;
      if (!exact.has(n)) exact.set(n, c.id);
      const l = stripBranch(n);
      // 느슨한 형태가 다른 회사와 충돌하면 등록하지 않는다 (오탐 방지)
      if (l && l !== n) {
        loose.set(l, loose.has(l) && loose.get(l) !== c.id ? "__ambiguous__" : c.id);
      }
    }
  }
  for (const [k, v] of loose) if (v === "__ambiguous__") loose.delete(k);
  return { exact, loose, byId };
}

/**
 * 소스에 표기된 회사명을 감시 대상과 대조한다.
 * 1) 정확 매칭  2) 지사 접미어 제거 매칭  3) 포함 관계 매칭
 * 3단계는 짧은 이름에서 오탐이 나기 쉬워 4글자 이상일 때만 허용한다.
 */
export function matchCompany(companyRaw: string, idx: CompanyIndex): string | null {
  const n = normalizeCompany(companyRaw);
  if (!n) return null;

  const hit = idx.exact.get(n);
  if (hit) return hit;

  const looseHit = idx.loose.get(stripBranch(n));
  if (looseHit) return looseHit;

  for (const [known, id] of idx.exact) {
    if (known.length < 4) continue;
    if (n.includes(known) || known.includes(n)) return id;
  }
  return null;
}
