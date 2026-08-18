# PriceScan Collector

PriceScan 웹앱에서 실행한 상품스캔 요청을 받아 사용자의 Chrome 브라우저로 쇼핑몰 검색 화면을 열고, 현재 보이는 DOM에서 가격 비교 정보를 수집하는 Chrome Extension입니다.

## 로컬 설치

일반 사용자에게는 로컬 설치를 안내하지 않습니다. 일반 사용자용은 Chrome Web Store 배포 후 `Chrome에 추가` 버튼으로 설치하게 만듭니다.

로컬 개발/검수에서는 두 가지 방법을 사용할 수 있습니다.

### 기본 검수 방식

PriceScan 웹앱의 `PriceScan 전용 크롬 열기` 버튼을 누르면 가격수집기가 미리 로드된 별도 Chrome 창이 열립니다.

로컬 검수에서는 열린 Chrome 창이 PriceScan에 자동 로그인되고, 우측 상단 `크롬수집기` 상태로 연결 여부를 확인할 수 있습니다.

### 수동 로컬 설치

수동 로컬 설치는 개발자용 예외 경로입니다. 일반 사용자는 이 방식을 사용하지 않습니다.

PriceScan 웹앱의 `설치화면 열기` 버튼을 누르면 실제 Chrome의 확장 관리 화면을 열고 아래 폴더 경로를 복사합니다.

그 다음 Chrome에서 아래 작업을 직접 진행합니다.

1. 우측 상단 `개발자 모드`를 켭니다.
2. `압축해제된 확장 프로그램을 로드`를 누릅니다.
3. 이 폴더를 선택합니다.

```text
/Users/bannykick/Documents/work/pricescan/extensions/pricescan-collector
```

Chrome 보안 정책상 웹사이트가 확장 프로그램 설치를 완전히 자동 완료할 수는 없습니다. 로컬 개발 설치에서는 사용자가 최종 폴더 선택을 해야 합니다.

## 동작 흐름

1. PriceScan 웹앱이 `PRICESCAN_COLLECTOR_PING` 메시지를 보냅니다.
2. 확장 프로그램 content script가 `PRICESCAN_COLLECTOR_PONG`으로 응답합니다.
3. 사용자가 상품스캔을 누르면 웹앱이 수집 요청을 보냅니다.
4. background service worker가 네이버/다나와/에누리/쿠팡 검색 탭을 엽니다.
5. 각 탭에서 상품명, 판매처, 등록가, 노출가, 배송비, 링크를 최대 10개 추출합니다.
6. `/price-search/extension-results`로 결과를 저장합니다.

## 네이버 수집 동작

- PriceScan 화면에서 네이버 검색 간격을 30초, 60초, 120초로 선택할 수 있습니다.
- 기본 검색 간격은 60초이며, 연속 요청은 남은 시간만큼 기다린 뒤 자동으로 실행됩니다.
- 네이버 전용 탭을 재사용해 검색할 때마다 새 탭을 만들지 않습니다.
- 보안 확인 화면이 나타나면 해당 탭을 사용자에게 보여주고 최대 10분 동안 기다립니다.
- 사용자가 보안 질문을 완료하면 같은 탭에서 가격수집을 자동으로 계속합니다.

## 수집 범위

- 상품명
- 판매처/출처
- 등록가
- 노출가
- 배송비
- 상품 링크

아이디, 비밀번호, 쿠키, 결제정보, 로컬스토리지는 수집하지 않습니다.

## 운영 배포

크롬 웹스토어에 배포한 뒤 PriceScan 프론트엔드 환경변수에 설치 URL을 연결합니다.

```text
VITE_PRICESCAN_EXTENSION_URL=https://chromewebstore.google.com/detail/...
```
