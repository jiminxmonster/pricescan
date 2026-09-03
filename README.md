# PriceScan

셀러용 가격수집/가격비교/상품등록 자동화 프로젝트입니다.

## 현재 복구 상태

이 폴더는 기존 `_preserved` 폴더를 `pricescan`으로 변경한 뒤, 옛날 Auto Seller 핵심 기능을 실제 프론트엔드/백엔드 구조로 복구하는 프로젝트입니다.

포함된 기능:

- 상품검색/가격비교
- 최저가 기준 선택
- 이상가 제외 권장 표시
- 예상 마진 계산
- API 등록 모드
- 쇼핑몰 자동등록
- 통합가격 조정
- 송장 자동출력
- 회원/권한
- 작업 로그

## 실행

```bash
cd /Users/bannykick/Documents/work/pricescan
docker compose up --build
```

접속:

```text
http://127.0.0.1:8300/pricescan/
```

백엔드 확인:

```text
http://127.0.0.1:8400/health
```

기본 로그인:

```text
admin / admin
```

## PriceScan 전용 브라우저

### 판매상품 중심 작업 흐름

1. 상품명/모델명을 검색하면 `내 판매상품` 초안이 먼저 생성됩니다. 동일 검색어는 대소문자·공백 차이를 정규화해 중복 생성하지 않습니다.
2. 판매가, 매입 원가, 수수료율, 판매자 부담 배송비는 **빈 값**으로 시작합니다. 누락값이 있는 동안 `(N)`을 표시합니다. 경쟁상품 가격을 내 원가로 추정하지 않습니다.
3. 검색 상단에 쇼핑몰별 배송비 포함 최저가 후보와 가격 분포를 표시합니다. 아래 쇼핑몰별 표는 기본 10개이며 더 많은 실제 후보는 펼쳐볼 수 있습니다. 5개 미만이면 부족 상태를 명시합니다. 제외/이상가도 검토할 수 있지만 요약 최저가에는 포함하지 않습니다.
4. 상품명을 누르면 원본으로 이동합니다. 우측 모니터링 체크 시 행이 옅은 빨강으로 표시되고 선택한 내 상품에 연결됩니다.
5. `내 판매상품`의 상단 계산 영역은 고정되고 경쟁상품 목록은 아래에서 스크롤됩니다. 판매가 변경 시 `판매가 - 원가 - 반올림(판매가 × 수수료율 / 100) - 배송비`로 예상이익과 매출 기준 마진율을 즉시 계산합니다. 세금·반품비 등은 별도이며 쇼핑몰 판매가를 실제로 변경하지 않습니다.
6. `전체 재검색`은 새로운 경쟁상품도 찾습니다. 모니터링은 쇼핑몰+원본 URL 기준으로 이어지며 최근 24회 관측 이력을 표시합니다. 이번 결과에 없는 선택 상품은 이전 가격으로 명시합니다. 체크 해제 후에도 가격 이력은 보존합니다.

판매 초안/선택/이력은 별도 `seller_*` 테이블에 저장합니다. 기존 `prepared_products` 데이터는 삭제하거나 판매 초안으로 임의 변환하지 않습니다. 현재 로컬 단일 관리자용이며 판매 채널 API 연동이나 다중 사용자 격리는 별도 작업입니다.

### 우측 AI 상담 (선택 기능)

`AI 상담` 탭은 현재 선택 상품에 관한 패널을 엽니다. 기본은 **AI 미연결**입니다. 마진 계산에는 AI가 필요하지 않습니다.

서버 `.env`에 `PRICESCAN_AI_API_KEY`, `PRICESCAN_AI_MODEL`을 직접 설정하고 백엔드를 재시작하면 DeepSeek Chat Completions에 연결합니다. 키는 프론트엔드에 전달하지 않습니다. 모델은 계정에서 이용 가능한 모델 ID를 선택하세요.

전송 동의와 질문 제출 시에만 선택 상품의 저장된 원가·판매가·수수료·배송비 및 모니터링 정보, 해당 상품의 최근 대화를 전송합니다. 다른 상품, 브라우저 쿠키, 로그인 인증정보는 전송하지 않습니다. AI에게 브라우저 제어나 가격 변경 도구를 제공하지 않습니다. 대화 내용은 현재 화면의 메모리에만 유지되며 새로고침하면 사라집니다.

### 전용 브라우저 실행

**새 독립형 앱:** `desktop/`의 Electron 기반 **PriceScan Desktop**을 사용합니다.
네이버와 다른 쇼핑몰 작업이 독립적으로 진행되며, 로그인·보안확인 시 사용자에게
알림을 보내고 정상 화면 복귀 후 수집합니다. 먼저 저장된 쇼핑몰 결과부터 판매상품에
연결합니다. 중지·이어가기·재시작 복원과 전용 로그인 세션을 지원합니다.
빌드·보안 경계·검증 절차는 [desktop/README.md](desktop/README.md)를 참고하세요.
현재 UI/API는 기존 로컬 Docker 서비스에 의존하며, 공개 배포용 서명·공증은 별도입니다.
기존 실행기/웹 화면의 열기 버튼은 검증 완료된 새 앱 빌드가 있으면 이를 우선 실행합니다.

아래는 새 앱 빌드가 없을 때 사용하는 기존 Chrome 실행기입니다.

전용 브라우저 앱을 만들려면 다음 명령을 한 번 실행합니다.

```bash
./scripts/build-pricescan-browser-app.sh
```

생성된 `artifacts/pricescan-browser/PriceScan Browser.app`을 열면 로컬 PriceScan 서비스와 보조기를 확인한 뒤 가격수집기 익스텐션이 연결된 브라우저를 실행합니다.

- 쇼핑몰 로그인과 쿠키는 `~/Library/Application Support/PriceScan Browser/profile-v2`에 유지됩니다.
- 실행 충돌 복구를 위해 새 영구 프로필로 전환했습니다. 기존 `profile` 폴더는 삭제·수정하지 않고 그대로 보관하며, 새 프로필에서는 쇼핑몰에 다시 로그인해야 합니다. 기존 쿠키나 인증정보를 자동으로 복사하지 않습니다.
- macOS 앱 실행 경로로 전용 프로필과 수집기를 함께 엽니다. Codex 내부 미리보기나 일반 Chrome 새 탭은 수집기가 연결된 전용 창이 아닙니다.
- PriceScan 익스텐션은 프로젝트의 최신 로컬 버전을 자동으로 불러옵니다.
- CAPTCHA 해결, 브라우저 지문 위장, 프록시 회전 기능은 포함하지 않습니다.

## Vultr 배포

일반 업데이트는 `main` 푸시 후 로컬에서 배포 스크립트를 실행합니다.

```bash
./scripts/deploy-vultr.sh
```

최초 서버 구성은 아래 명령으로 진행합니다.

서버에서:

```bash
apt update && apt upgrade -y
apt install -y git docker.io docker-compose-v2 nginx certbot python3-certbot-nginx
systemctl enable --now docker

cd /opt
git clone https://github.com/jiminxmonster/pricescan.git
cd pricescan
docker compose up -d --build
```

Nginx 경로 배포:

```bash
cp /opt/pricescan/deploy/nginx/d2blue-pricescan.conf /etc/nginx/sites-available/d2blue
ln -sf /etc/nginx/sites-available/d2blue /etc/nginx/sites-enabled/d2blue
nginx -t
systemctl reload nginx
```

DNS에서 `pricescan.d2blue.com`의 A 레코드를 Vultr 서버 IP로 연결한 뒤 SSL을 발급합니다.

```bash
certbot --nginx -d pricescan.d2blue.com
```

최종 접속:

```text
https://pricescan.d2blue.com/pricescan/
```

## 보관본

이전 보관본은 `_archive` 아래에 남겨두었습니다.

- `_archive/auto_seller_legacy_20260701`
- `_archive/clean_decision_from_auto_seller_20260701`
- `legacy-static/index.html`

## 다음 단계

현재는 React/Vite 프론트엔드, FastAPI 백엔드, SQLite 저장소, Docker Compose 실행까지 복구했습니다. 가격검색은 네이버쇼핑/다나와/에누리/쿠팡 검색 페이지 수집을 기준으로 두고, 다음 단계에서 가격 이력 DB 고도화, 회원별 워크스페이스, 송장 출력 연동을 붙이면 됩니다.

## 배포 상품 분리

- 웹 + Chrome Extension: 일반 사용자는 Chrome Web Store에서 확장 프로그램을 설치합니다. 확장 프로그램은 사용자가 직접 확인한 네이버 쇼핑 현재 화면을 한 번만 가져오며, 다나와·에누리·쿠팡은 웹 서버 수집으로 처리합니다.
- Desktop: 기존 전용 브라우저 포함 macOS 앱은 별도 다운로드로 제공합니다. `artifacts/downloads/PriceScan-Desktop-macOS-arm64-2026-09-02.zip`이 현재 설치 패키지이며, 외부 공개 전 Apple Developer ID 서명과 공증이 필요합니다.
- Chrome Web Store: `artifacts/chrome-webstore/pricescan-collector-0.2.0-webstore.zip`과 `extensions/pricescan-collector/chrome-web-store-checklist.md`를 사용합니다.
