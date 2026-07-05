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

## Vultr 배포

서버에서:

```bash
apt update && apt upgrade -y
apt install -y git docker.io docker-compose-plugin nginx certbot python3-certbot-nginx
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

DNS에서 `www.d2blue.com`의 A 레코드를 Vultr 서버 IP로 연결한 뒤 SSL을 발급합니다.

```bash
certbot --nginx -d www.d2blue.com
```

최종 접속:

```text
https://www.d2blue.com/pricescan/
```

## 보관본

이전 보관본은 `_archive` 아래에 남겨두었습니다.

- `_archive/auto_seller_legacy_20260701`
- `_archive/clean_decision_from_auto_seller_20260701`
- `legacy-static/index.html`

## 다음 단계

현재는 React/Vite 프론트엔드, FastAPI 백엔드, SQLite 저장소, Docker Compose 실행까지 복구했습니다. 다음 단계에서 네이버 쇼핑 검색 API 실제 호출, 가격 이력 DB 고도화, 회원별 워크스페이스, 송장 출력 연동을 붙이면 됩니다.
