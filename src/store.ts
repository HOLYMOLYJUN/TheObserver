import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Posting } from "./types.ts";
import { postingKey } from "./types.ts";
import { config } from "./config.ts";
import { log } from "./logger.ts";

const STORE_PATH = fileURLToPath(new URL("../data/seen.json", import.meta.url));

interface SeenEntry {
  firstSeen: string;
  company: string;
  title: string;
}

interface StoreFile {
  version: 1;
  /** 부트스트랩(최초 조용한 등록)이 끝났는지 */
  bootstrapped: boolean;
  lastRunAt: string | null;
  postings: Record<string, SeenEntry>;
}

const EMPTY: StoreFile = { version: 1, bootstrapped: false, lastRunAt: null, postings: {} };

export class Store {
  private constructor(private data: StoreFile) {}

  static async load(): Promise<Store> {
    try {
      const raw = await readFile(STORE_PATH, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreFile>;
      return new Store({ ...EMPTY, ...parsed, postings: parsed.postings ?? {} });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        log.info("seen.json 없음 — 새로 시작합니다.");
        return new Store({ ...EMPTY, postings: {} });
      }
      // 파일이 깨졌으면 알림 폭탄이 나므로 실패시킨다 (조용히 리셋하지 않음)
      throw new Error(`seen.json 을 읽을 수 없습니다: ${(err as Error).message}`);
    }
  }

  get isBootstrapped(): boolean {
    return this.data.bootstrapped;
  }

  get size(): number {
    return Object.keys(this.data.postings).length;
  }

  has(p: Posting): boolean {
    return postingKey(p) in this.data.postings;
  }

  /** 아직 본 적 없는 공고만 골라낸다 */
  filterNew(postings: Posting[]): Posting[] {
    const seenInThisRun = new Set<string>();
    return postings.filter((p) => {
      const key = postingKey(p);
      if (this.has(p) || seenInThisRun.has(key)) return false;
      seenInThisRun.add(key);
      return true;
    });
  }

  record(postings: Posting[]): void {
    const now = new Date().toISOString();
    for (const p of postings) {
      this.data.postings[postingKey(p)] = {
        firstSeen: now,
        company: p.companyRaw,
        title: p.title,
      };
    }
  }

  markBootstrapped(): void {
    this.data.bootstrapped = true;
  }

  /** 보관 기간이 지난 항목 제거 — 파일 무한 증가 방지 */
  prune(): number {
    const cutoff = Date.now() - config.retentionDays * 86_400_000;
    let removed = 0;
    for (const [key, entry] of Object.entries(this.data.postings)) {
      if (Date.parse(entry.firstSeen) < cutoff) {
        delete this.data.postings[key];
        removed++;
      }
    }
    return removed;
  }

  async save(): Promise<void> {
    this.data.lastRunAt = new Date().toISOString();
    await mkdir(dirname(STORE_PATH), { recursive: true });
    // 키를 정렬해 두면 커밋 diff가 안정적이다
    const sorted = Object.fromEntries(
      Object.entries(this.data.postings).sort(([a], [b]) => a.localeCompare(b)),
    );
    const out = { ...this.data, postings: sorted };
    await writeFile(STORE_PATH, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  }
}
