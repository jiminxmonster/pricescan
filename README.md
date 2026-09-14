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

## 기본 사용 방식: 웹 + Chrome 확장 프로그램

PriceScan의 기본 제품은 `https://pricescan.d2blue.com/pricescan/` 웹 화면입니다. 별도 Chrome 확장 프로그램이나 쇼핑몰 로그인이 필요하지 않습니다. 웹 검색창에 상품명을 한 번 입력하면 서버 AI가 네이버·다나와·에누리·쿠팡의 공개 웹 가격 정보를 동시에 조사하고, 확인된 출처 링크와 후보를 한 표로 정리합니다. 공개 웹에서 확인할 수 없는 쇼핑몰은 결과를 만들지 않고 사유를 표시합니다.

독립형 Desktop 앱과 예전 전용 브라우저 실행기는 현재 기본 흐름이 아닌 보관·호환용입니다. 새 사용자는 설치하지 않아도 됩니다.

### 판매상품 중심 작업 흐름

1. 상품명/모델명을 검색하면 `내 판매상품` 초안이 먼저 생성됩니다. 동일 검색어는 대소문자·공백 차이를 정규화해 중복 생성하지 않습니다.
2. 판매가, 매입 원가, 수수료율, 판매자 부담 배송비는 **빈 값**으로 시작합니다. 누락값이 있는 동안 `(N)`을 표시합니다. 경쟁상품 가격을 내 원가로 추정하지 않습니다.
3. 검색 상단에 쇼핑몰별 배송비 포함 최저가 후보와 가격 분포를 표시합니다. 아래 쇼핑몰별 표는 기본 10개이며 더 많은 실제 후보는 펼쳐볼 수 있습니다. 5개 미만이면 부족 상태를 명시합니다. 제외/이상가도 검토할 수 있지만 요약 최저가에는 포함하지 않습니다.
4. 상품명을 누르면 원본으로 이동합니다. 우측 모니터링 체크 시 행이 옅은 빨강으로 표시되고 선택한 내 상품에 연결됩니다.
5. `내 판매상품`의 상단 계산 영역은 고정되고 경쟁상품 목록은 아래에서 스크롤됩니다. 판매가 변경 시 `판매가 - 원가 - 반올림(판매가 × 수수료율 / 100) - 배송비`로 예상이익과 매출 기준 마진율을 즉시 계산합니다. 세금·반품비 등은 별도이며 쇼핑몰 판매가를 실제로 변경하지 않습니다.
6. `전체 재검색`은 새로운 경쟁상품도 찾습니다. 모니터링은 쇼핑몰+원본 URL 기준으로 이어지며 최근 24회 관측 이력을 표시합니다. 이번 결과에 없는 선택 상품은 이전 가격으로 명시합니다. 체크 해제 후에도 가격 이력은 보존합니다.

판매 초안/선택/이력은 별도 `seller_*` 테이블에 저장합니다. 기존 `prepared_products` 데이터는 삭제하거나 판매 초안으로 임의 변환하지 않습니다. 슈퍼관리자는 사용자별 역할, 검색 허용 여부, 하루 검색 횟수를 관리할 수 있습니다. 신규 관리자와 일반 사용자의 기본 검색 한도는 하루 10회입니다.

### 우측 AI 상담 (선택 기능)

`AI 상담` 탭은 현재 선택 상품에 관한 패널을 엽니다. 기본은 **AI 미연결**입니다. 마진 계산에는 AI가 필요하지 않습니다.

슈퍼관리자 화면에서 OpenAI 호환 API의 키, 모델, 기본 주소를 설정할 수 있습니다. API 키는 서버 영구 볼륨에 암호화해 저장하고, 저장 이후 브라우저나 API 응답에 원문을 다시 보내지 않습니다. 모델은 해당 API 계정에서 실제 이용 가능한 모델 ID를 선택하세요. 슈퍼관리자 암호는 평문 대신 `PRICESCAN_SUPERADMIN_PASSWORD_HASH` 환경변수에 bcrypt 해시로 설정합니다.

전송 동의와 질문 제출 시에만 선택 상품의 저장된 원가·판매가·수수료·배송비 및 모니터링 정보, 해당 상품의 최근 대화를 전송합니다. 다른 상품, 브라우저 쿠키, 로그인 인증정보는 전송하지 않습니다. AI에게 브라우저 제어나 가격 변경 도구를 제공하지 않습니다. 대화 내용은 현재 화면의 메모리에만 유지되며 새로고침하면 사라집니다.

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

현재 기본 가격검색은 서버 관리형 AI 브라우저 조사입니다. 서버가 쇼핑몰별 검색 주소와 판독 규칙을 갱신하고, Chrome 확장 프로그램은 로그인된 사용자의 현재 화면에서 주요 콘텐츠 텍스트와 공개 링크만 제한된 크기로 전달합니다. 고정 파서는 이 흐름의 대체 수단으로 실행하지 않습니다.

## 배포 상품 분리

- 웹: 기본 제품입니다. 네이버·다나와·에누리·쿠팡을 서버 AI의 공개 웹 검색으로 조사하므로 Chrome 확장 프로그램이나 쇼핑몰 로그인 세션이 필요하지 않습니다. 확인된 출처 URL만 결과로 채택하며 공개 정보가 부족하면 해당 쇼핑몰을 `확인 필요`로 남깁니다.
- Chrome Extension: 이전 사용자 감시형 수집과 호환하기 위한 별도 패키지이며 기본 웹 검색 흐름에서는 사용하지 않습니다.
- Desktop: 개인 테스트 모드에서는 운영 PriceScan 화면을 앱 안에 열고, 검색 한 번으로 네이버만 로그인된 전용 화면에서 AI 감독형으로 조사합니다. 로그인·캡차·보안 확인에서는 멈춰 사용자 처리를 기다리고, 다나와·에누리·쿠팡은 서버 AI가 병행 조사합니다. 운영 배포판 연결은 `PRICESCAN_APP_URL=https://pricescan.d2blue.com/pricescan/ npm start --prefix desktop`으로 실행합니다. 외부 공개 전 Apple Developer ID 서명과 공증이 필요합니다.
- Chrome Web Store: `scripts/build-pricescan-collector-webstore.sh`로 0.5.3 업로드 ZIP을 만들고 `extensions/pricescan-collector/chrome-web-store-checklist.md`를 확인합니다. ZIP 생성은 스토어 등록/게시 완료를 의미하지 않습니다.

### AI 감독형 수집 개발 검증

- 정상 인식 시 검색 한 번으로 네 쇼핑몰을 차례로 조사합니다. 최초 설치 때만 접근 권한 버튼을 누르며, 읽지 못한 가격·배송비는 사용자 확인을 요청합니다. 미확인 배송비를 무료로 저장하지 않습니다.
- 인증/차단에서는 다음으로 자동 이동하거나 재시도하지 않습니다. 사용자 처리 후 승인하거나 해당 상품/쇼핑몰을 제외합니다.
- 중간 상태는 확장 프로그램 로컬 저장소에 보관합니다. 최종 결과는 검색을 시작한 웹 origin과 판매상품 ID로만 전달하며, 서버의 저장 성공 응답 전에는 완료 처리하지 않습니다. 같은 최종 승인 ID의 재전송은 중복 실행을 만들지 않습니다.
- `node --test extensions/pricescan-collector/*test.cjs`, 프론트엔드 타입 검사/테스트/빌드, `backend/tests/test_extension_collection.py`로 회귀 검증합니다.
- `approval-panel.html?preview=1`은 확장 런타임이 없는 로컬 HTTP 서버에서만 동작하는 **예시 데이터 미리보기**입니다. 실제 쇼핑몰 접속/전송/저장 성공을 시뮬레이션하지 않습니다.
- 브라우저 개발 테스트는 사용자가 지정한 CleanFile 외장 프로필만 사용합니다. 연결을 확인할 수 없으면 일반 Chrome이나 Codex 브라우저로 대체하지 않습니다. IndexedDB는 삭제하지 않습니다.
