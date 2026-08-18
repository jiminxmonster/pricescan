# PriceScan Collector Chrome Web Store 등록 준비

## 등록 방향

PriceScan Collector는 PriceScan 사용자가 네이버쇼핑, 다나와, 에누리, 쿠팡 검색 화면에서 실제로 보이는 상품 가격 정보를 PriceScan으로 수집하기 위한 Chrome Extension입니다.

일반 사용자는 로컬 압축해제 설치를 하지 않습니다. Chrome Web Store에서 `Chrome에 추가`로 설치합니다.

초기 배포 방식은 `Unlisted`입니다. Chrome Web Store 검색에는 노출하지 않고, PriceScan에서 제공하는 설치 링크를 가진 사용자만 설치하게 합니다.

공식 참고:

- [Register your developer account](https://developer.chrome.com/docs/webstore/register)
- [Publish in the Chrome Web Store](https://developer.chrome.com/docs/webstore/publish)
- [Fill out the privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [Chrome Web Store Program Policies](https://developer.chrome.com/docs/webstore/program-policies)

## 제출 ZIP

패키지 생성:

```bash
cd /Users/bannykick/Documents/work/pricescan
./scripts/build-pricescan-collector-webstore.sh
```

업로드 파일:

```text
/Users/bannykick/Documents/work/pricescan/artifacts/chrome-webstore/pricescan-collector-0.1.1-webstore.zip
```

## 미공개 등록 순서

1. [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole/)에 접속합니다.
2. 개발자 계정 등록과 일회성 등록비 결제를 완료합니다.
3. `새 항목` 또는 `New item`을 선택합니다.
4. 위 제출 ZIP을 업로드합니다.
5. 스토어 등록 정보, 개인정보, 권한 사유를 아래 문구 기준으로 입력합니다.
6. 공개 범위는 `Unlisted`로 선택합니다.
7. 심사 제출 후 승인되면 설치 URL을 복사합니다.
8. PriceScan 배포 환경에 `VITE_PRICESCAN_EXTENSION_URL` 값을 설정합니다.

```text
VITE_PRICESCAN_EXTENSION_URL=https://chromewebstore.google.com/detail/...
```

## 스토어 기본 정보

확장 프로그램 이름:

```text
PriceScan Collector
```

짧은 설명:

```text
쇼핑몰 화면에 보이는 상품 가격 정보를 PriceScan으로 수집합니다.
```

상세 설명:

```text
PriceScan Collector는 PriceScan 사용자가 네이버쇼핑, 다나와, 에누리, 쿠팡에서 실제로 보는 상품 가격 정보를 수집해 PriceScan 가격 비교 화면으로 보내는 확장 프로그램입니다.

사용자는 PriceScan에서 상품명을 입력하고 상품스캔을 실행합니다. 확장 프로그램은 선택된 쇼핑몰 검색 결과 페이지를 열고, 화면에 표시된 상품명, 판매처, 등록가, 노출가, 배송비, 상품 링크를 최대 10개씩 추출합니다.

이 확장 프로그램은 아이디, 비밀번호, 쿠키, 결제정보, 장바구니, 개인 메시지, 연락처를 수집하지 않습니다. 수집된 가격 정보는 사용자의 PriceScan 계정/서버로 전송되어 가격 비교, 최저가 그래프, 마진 검토에 사용됩니다.
```

카테고리:

```text
Productivity
```

언어:

```text
Korean
```

## 단일 목적 설명

```text
PriceScan Collector의 단일 목적은 사용자가 PriceScan에서 요청한 쇼핑몰 검색 화면의 상품 가격 정보를 읽어 PriceScan 가격 비교 화면으로 전송하는 것입니다.
```

## 권한 사용 사유

### scripting

```text
사용자가 PriceScan에서 상품스캔을 실행하면 네이버쇼핑, 다나와, 에누리, 쿠팡 검색 결과 탭의 DOM을 읽어 상품명, 판매처, 가격, 배송비, 링크를 추출하기 위해 사용합니다.
```

### tabs

```text
PriceScan의 요청에 따라 쇼핑몰 검색 결과 탭을 열고, 페이지 로딩 완료 시점을 확인하며, 수집 대상 탭을 관리하기 위해 사용합니다.
```

### storage

```text
최근 수집 검색어, 확장 프로그램 버전, PriceScan 연결 상태 같은 최소한의 로컬 상태를 저장하기 위해 사용합니다.
```

## 호스트 권한 사용 사유

### https://pricescan.d2blue.com/*

```text
PriceScan 웹앱과 확장 프로그램이 연결 상태를 확인하고, 사용자가 요청한 상품스캔 작업을 확장 프로그램으로 전달하기 위해 사용합니다.
```

### https://shopping.naver.com/*, https://search.shopping.naver.com/*

```text
네이버쇼핑 검색 결과 화면에서 사용자가 보는 상품 가격 정보를 추출하기 위해 사용합니다.
```

### https://www.danawa.com/*, https://search.danawa.com/*

```text
다나와 검색 결과 화면에서 사용자가 보는 상품 가격 정보를 추출하기 위해 사용합니다.
```

### https://www.enuri.com/*

```text
에누리 검색 결과 화면에서 사용자가 보는 상품 가격 정보를 추출하기 위해 사용합니다.
```

### https://www.coupang.com/*

```text
쿠팡 검색 결과 및 상품 상세 화면에서 사용자가 보는 등록가, 노출가, 쿠폰 가격 정보를 추출하기 위해 사용합니다.
```

## 데이터 수집 고지

수집하는 데이터:

- 상품명
- 쇼핑몰/판매처명
- 등록가
- 노출가
- 배송비
- 쿠폰/혜택 표시 텍스트
- 상품 링크
- 수집 시각

수집하지 않는 데이터:

- 아이디
- 비밀번호
- 쿠키
- 결제정보
- 카드정보
- 장바구니
- 연락처
- 개인 메시지
- 브라우징 전체 기록

## 심사 전 체크리스트

- [ ] Chrome Web Store 개발자 계정 등록
- [ ] 일회성 개발자 등록비 결제
- [ ] PriceScan 개인정보처리방침 URL 준비
- [ ] 제출 ZIP 업로드
- [ ] 스토어 아이콘 업로드
- [ ] 스크린샷 1~3장 준비
- [ ] 권한 사용 사유 입력
- [ ] 데이터 수집 항목 입력
- [ ] 공개 범위 선택: Unlisted
- [ ] 승인 후 `VITE_PRICESCAN_EXTENSION_URL` 운영 환경변수 반영

초기 배포는 `Unlisted`를 권장합니다. 링크를 받은 사용자만 설치할 수 있어 베타 테스트에 적합합니다.

## CI/CD 업데이트

첫 버전은 Developer Dashboard에서 `Unlisted`로 직접 심사 제출하고 공개합니다. Chrome Web Store API는 새 항목 생성과 공개 범위 변경을 지원하지 않으며, 공개 범위를 변경한 뒤에는 해당 설정으로 한 번 직접 게시해야 합니다.

첫 게시 이후에는 `pricescan-collector-v<manifest version>` 태그를 푸시하면 `.github/workflows/chrome-webstore.yml`이 다음 작업을 수행합니다.

1. 확장 프로그램 테스트
2. Web Store용 ZIP 빌드
3. Chrome Web Store API V2로 패키지 업로드
4. 기존 `Unlisted` 공개 범위를 유지한 상태로 심사 제출

필요한 GitHub Actions Secrets:

- `CWS_SERVICE_ACCOUNT_JSON`: Chrome Web Store API를 사용할 Google Cloud 서비스 계정 JSON 키
- `CWS_PUBLISHER_ID`: Chrome Web Store 게시자 ID

서비스 계정 이메일은 Chrome Web Store Developer Dashboard의 `설정 → 서비스 계정`에도 등록해야 합니다.
