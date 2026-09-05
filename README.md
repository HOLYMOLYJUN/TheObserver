# TheObserver

관심 기업의 **개발 직군 채용공고**가 사람인·잡코리아에 올라오면 Slack으로 알려주는 봇.

GitHub Actions에서 돌기 때문에 **내 컴퓨터가 꺼져 있어도 작동한다.**

- 감시 대상: 18개 기업 (`data/companies.json`)
- 대상 직무: 웹 / 기획 / 앱 / 프론트 / 백 / 풀스택 등 개발 관련 전부
- 알림: 매일 **09:00 / 17:00 (KST)**, Slack 카드형

자세한 설계는 [`docs/PLAN.md`](docs/PLAN.md) 참고.

---

## 설정

### 1. Slack Incoming Webhook

1. <https://api.slack.com/apps> → **Create New App** → From scratch
2. **Incoming Webhooks** 활성화 → **Add New Webhook to Workspace** → 채널 선택
3. 발급된 URL을 복사

### 2. 사람인 API 키 (권장)

<https://oapi.saramin.co.kr> 에서 로그인 후 access-key 발급.
없어도 웹 파싱으로 동작하지만, **API 경로가 훨씬 안정적이다.** (1일 500회 한도)

### 3. GitHub Secrets 등록

리포 → Settings → Secrets and variables → Actions → **New repository secret**

| 이름 | 필수 | 값 |
|---|---|---|
| `SLACK_WEBHOOK_URL` | ✅ | 1번에서 복사한 URL |
| `SARAMIN_ACCESS_KEY` | 권장 | 2번에서 발급한 키 |

---

## 첫 실행 절차

### 1단계 — 회사 식별자 수집

Actions 탭 → **회사 식별자 수집 (수동)** → **Run workflow**

18개 기업을 양쪽 사이트에서 검색해 회사코드와 정확한 표기를 찾아
`company-candidates` 아티팩트로 올린다. 이걸 보고 `data/companies.json` 의
`saraminName` / `jobkoreaCode` 를 채운다.

> 이 단계 없이도 검색 기반으로 동작하지만, 회사코드를 채우면 정확도가 크게 올라간다.

### 2단계 — 검증

Actions 탭 → **채용공고 감시** → **Run workflow** → `dry_run` 체크

Slack으로 보내지 않고 로그에만 출력한다. 어떤 공고가 잡히는지 확인한다.

### 3단계 — 부트스트랩

`dry_run` 없이 한 번 실행. 최초 1회는 기존 공고를 **조용히 등록만** 하고
"N건 등록 완료" 요약 하나만 보낸다. (알림 폭탄 방지)

이후부터는 스케줄대로 새 공고만 알려준다.

---

## 감시 기업 추가

`data/companies.json` 에 항목을 추가하면 끝.

```json
{
  "id": "myco",
  "name": "(주)새회사",
  "aliases": ["새회사", "NewCo"],
  "industry": "IT/웹/통신",
  "region": "부산",
  "saraminName": null,
  "jobkoreaCode": null
}
```

`aliases` 에는 영문명·약칭·구 사명을 넣어두면 매칭률이 올라간다.
추가 후 **회사 식별자 수집** 워크플로를 다시 돌리면 코드가 채워진다.

---

## 로컬 실행

```bash
npm install
npm run watch:dry      # Slack 발송 없이 콘솔 출력만
npm test               # 매칭·파싱 로직 테스트
npm run typecheck
```

### 환경변수

| 이름 | 기본값 | 설명 |
|---|---|---|
| `DRY_RUN` | `false` | Slack 발송 생략 |
| `NO_DEV_FILTER` | `false` | 개발 직무 필터 끄기 |
| `MAX_CARDS` | `20` | 1회 발송 상한 |
| `RETENTION_DAYS` | `90` | `seen.json` 보관 기간 |
| `REQUEST_DELAY_MS` | `1500` | 요청 간 최소 간격 |
| `ALLOW_BROWSER_FALLBACK` | `true` | Playwright 폴백 허용 |
| `HEARTBEAT_DOW` | `1` | 하트비트 요일 (0=일, -1=비활성) |

---

## 알림이 안 올 때

1. **Actions 탭에서 최근 실행이 빨간불인가?** → 로그 확인. 실패하면 Slack으로도 🔴 카드가 간다.
2. **초록불인데 조용한가?** → 정말 새 공고가 없는 것. 월요일 오전 하트비트로 생존 확인 가능.
3. **스케줄이 안 도는가?** → 60일 무활동 시 GitHub이 자동으로 끈다.
   Actions 탭에 재활성화 배너가 뜬다. (`seen.json` 자동 커밋으로 예방하고 있음)
4. **수집 0건 경고가 뜨는가?** → 사이트 개편으로 셀렉터가 깨졌거나 러너 IP가 차단된 것.
   **회사 식별자 수집** 워크플로로 원본 HTML을 받아 확인한다.

---

## 크롤링 범위에 대한 원칙

CAPTCHA 우회 · 프록시 IP 로테이션 · 봇 탐지 회피는 **넣지 않는다.**
차단 회피는 군비경쟁이라 상대가 룰을 바꾸면 새벽에 알림이 조용히 죽는다.

이 도구는 하루 2회 조회해 본인 Slack에 링크를 던질 뿐이고, 재배포가 없으며,
트래픽은 사람 한 명이 브라우징하는 것보다 적다.
