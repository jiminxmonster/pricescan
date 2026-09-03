# Chrome Web Store 등록 체크리스트

- 업로드 ZIP: `artifacts/chrome-webstore/pricescan-collector-0.2.0-webstore.zip`
- 확장 프로그램 이름: `PriceScan - 네이버 현재 화면 가격 가져오기`
- 카테고리: `쇼핑`
- 언어: `한국어`
- 스토어 아이콘: `extensions/pricescan-collector/icons/icon-128.png`
- 스크린샷: `artifacts/chrome-webstore/store-assets/pricescan-home-1280x800.png`
- 개인정보 처리방침 URL: `https://pricescan.d2blue.com/pricescan/extension-privacy.html`
- 단일 목적 및 상세 설명: `extensions/pricescan-collector/store-listing-ko.md`
- 권한 사용 사유: `extensions/pricescan-collector/permissions-justification-ko.md`

## 데이터 사용 선언

- 처리 데이터: 사용자가 버튼을 누른 현재 네이버 쇼핑 화면의 상품명, 판매처, 가격, 배송비, 상품 링크
- 수집하지 않는 데이터: 인증정보, 비밀번호, 쿠키, 결제정보, 전체 브라우징 기록
- 목적: 사용자가 확인한 가격 비교 정보를 본인의 PriceScan 계정에 반영
- 광고/판매/신용평가/대출 목적 사용: 없음
- 원격 코드: 사용하지 않음

## 게시 전에 필요한 외부 준비

1. `pricescan.d2blue.com`에 현재 프론트엔드를 배포해 개인정보 처리방침 URL이 실제로 열리는지 확인합니다.
2. Chrome Web Store 개발자 계정의 본인 인증과 등록비 결제를 완료합니다.
3. ZIP 업로드 후 스토어 설명, 아이콘, 스크린샷, 권한 사유, 데이터 사용 선언을 입력합니다.
4. 초안 내용을 최종 검토한 뒤 게시 심사에 제출합니다.
