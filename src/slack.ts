import type { Posting, SourceResult } from "./types.ts";
import { config } from "./config.ts";
import { log } from "./logger.ts";

/** Slack은 메시지당 블록 50개가 상한. 카드 하나가 3블록이라 여유를 두고 자른다. */
const BLOCKS_PER_MESSAGE = 45;

const SOURCE_LABEL: Record<string, string> = {
  saramin: "사람인",
  jobkorea: "잡코리아",
};

type Block = Record<string, unknown>;

function divider(): Block {
  return { type: "divider" };
}

function header(text: string): Block {
  return { type: "header", text: { type: "plain_text", text: text.slice(0, 150), emoji: true } };
}

function context(text: string): Block {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

/** Slack mrkdwn 링크/강조 문법을 깨뜨리는 문자 이스케이프 */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function postingCard(p: Posting, companyName: string): Block[] {
  const fields: Block[] = [];
  const add = (label: string, value?: string) => {
    if (value?.trim()) fields.push({ type: "mrkdwn", text: `*${label}*\n${esc(value.trim())}` });
  };
  add("경력", p.experience);
  add("근무지", p.location);
  add("고용형태", p.employmentType);
  add("마감", p.deadline);

  const blocks: Block[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*<${p.url}|${esc(p.title)}>*\n:office: ${esc(companyName)}` },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "공고 보기", emoji: true },
        url: p.url,
        action_id: `open_${p.source}_${p.sourceId}`,
      },
    },
  ];
  // Slack section 의 fields 는 최대 10개
  if (fields.length > 0) blocks.push({ type: "section", fields: fields.slice(0, 10) });
  blocks.push(context(`${SOURCE_LABEL[p.source] ?? p.source}${p.postedAt ? ` · 등록 ${esc(p.postedAt)}` : ""}`));
  return blocks;
}

async function post(blocks: Block[], fallbackText: string): Promise<void> {
  if (config.dryRun) {
    log.info(`[DRY_RUN] Slack 발송 생략 — ${fallbackText}`);
    console.log(JSON.stringify({ text: fallbackText, blocks }, null, 2));
    return;
  }

  const res = await fetch(config.slackWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: fallbackText, blocks }),
  });

  if (!res.ok) {
    throw new Error(`Slack 전송 실패: HTTP ${res.status} ${await res.text()}`);
  }
}

/** 큰 블록 배열을 Slack 상한에 맞춰 여러 메시지로 쪼갠다 */
async function postChunked(blocks: Block[], fallbackText: string): Promise<void> {
  for (let i = 0; i < blocks.length; i += BLOCKS_PER_MESSAGE) {
    await post(blocks.slice(i, i + BLOCKS_PER_MESSAGE), fallbackText);
  }
}

export async function sendPostings(
  postings: Posting[],
  companyName: (id?: string) => string,
  warnings: string[],
): Promise<void> {
  const shown = postings.slice(0, config.maxCards);
  const hidden = postings.length - shown.length;

  const blocks: Block[] = [header(`새 개발 공고 ${postings.length}건`)];
  for (const p of shown) {
    blocks.push(divider(), ...postingCard(p, companyName(p.companyId) || p.companyRaw));
  }
  if (hidden > 0) {
    blocks.push(divider(), context(`_외 ${hidden}건은 다음 실행에서 전송됩니다._`));
  }
  if (warnings.length > 0) {
    blocks.push(divider(), context(`:warning: ${warnings.map(esc).join("\n")}`));
  }

  await postChunked(blocks, `새 개발 공고 ${postings.length}건`);
}

/** 신규 0건이어도 주기적으로 보내는 생존 신호 */
export async function sendHeartbeat(
  companyCount: number,
  results: SourceResult[],
  seenCount: number,
): Promise<void> {
  const status = results
    .map((r) => `${SOURCE_LABEL[r.source] ?? r.source} ${r.ok ? "✅" : "❌"} (${r.postings.length}건 조회)`)
    .join(" · ");

  await post(
    [
      context(
        `:heartbeat: *TheObserver 정상 작동 중*\n` +
          `감시 기업 ${companyCount}곳 · 누적 공고 ${seenCount}건 · 신규 없음\n${status}`,
      ),
    ],
    "TheObserver 정상 작동 중",
  );
}

export async function sendBootstrapNotice(count: number, companyCount: number): Promise<void> {
  await post(
    [
      header("TheObserver 감시 시작"),
      context(
        `기존 공고 *${count}건*을 등록했습니다. (알림 폭탄 방지를 위해 개별 알림은 생략)\n` +
          `이제부터 *${companyCount}곳*의 새 개발 공고만 알려드립니다.`,
      ),
    ],
    "TheObserver 감시 시작",
  );
}

/** 크래시했을 때 — 조용히 죽지 않게 하는 마지막 방어선 */
export async function sendError(err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  // stack 은 보통 메시지로 시작한다. 카드에 같은 문구가 두 번 찍히지 않도록 프레임만 남긴다.
  const stack = err instanceof Error
    ? (err.stack ?? "").split("\n").filter((l) => /^\s+at /.test(l)).slice(0, 5).join("\n")
    : "";
  try {
    await post(
      [
        header("🔴 TheObserver 실행 실패"),
        { type: "section", text: { type: "mrkdwn", text: `\`\`\`${esc(`${message}\n${stack}`).slice(0, 2800)}\`\`\`` } },
        context("GitHub Actions 로그를 확인하세요."),
      ],
      `TheObserver 실행 실패: ${message}`,
    );
  } catch (notifyErr) {
    log.error("에러 알림 전송마저 실패했습니다:", notifyErr);
  }
}
