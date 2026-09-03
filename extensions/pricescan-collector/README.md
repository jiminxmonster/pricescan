# PriceScan Chrome Extension

네이버 쇼핑 결과를 사용자가 직접 확인한 뒤, 현재 화면에 로드된 상품을 최대 10개까지 PriceScan으로 가져오는 최소 권한 확장 프로그램입니다.

## 사용 방법

1. Chrome에서 네이버 쇼핑을 직접 검색합니다.
2. 결과가 맞는지 확인하고 필요하면 정렬·필터를 직접 조정합니다.
3. Chrome 도구막대의 PriceScan 아이콘을 누릅니다.
4. `현재 화면 최대 10개 가져오기`를 누릅니다.
5. 열린 PriceScan에서 수집 결과를 확인합니다.

확장 프로그램은 자동 검색, 자동 스크롤, 자동 클릭, 재시도, CAPTCHA 처리를 하지 않습니다. 버튼을 누른 시점의 현재 네이버 쇼핑 화면만 한 번 읽습니다.

## 권한

- `activeTab`: 사용자가 확장 프로그램을 누른 현재 탭에만 일시적으로 접근합니다.
- `scripting`: 현재 네이버 화면에서 상품명·가격·판매처·배송비·링크를 읽습니다.
- `storage`: PriceScan 페이지로 이동하는 동안 한 번의 수집 결과를 임시 보관합니다. 반영이 완료되면 삭제합니다.
- `https://pricescan.d2blue.com/*`: 임시 결과를 PriceScan 웹앱에 전달합니다.

로그인 정보, 쿠키, 비밀번호, 결제정보, 검색기록 전체는 읽거나 전송하지 않습니다.

## 개발자 로컬 설치

Chrome의 `chrome://extensions`에서 개발자 모드를 켜고 이 폴더를 `압축해제된 확장 프로그램을 로드`로 선택합니다. 일반 사용자는 Chrome Web Store 버전을 설치합니다.

## 배포 패키지

```bash
./scripts/build-pricescan-collector-webstore.sh
```

생성된 ZIP만 Chrome Web Store에 업로드합니다. 데스크톱 앱은 확장 프로그램과 별도의 다운로드 상품으로 배포합니다.
