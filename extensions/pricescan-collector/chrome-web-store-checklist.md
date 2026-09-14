# Chrome Web Store 등록 체크리스트

- 업로드 ZIP: `scripts/build-pricescan-collector-webstore.sh` 출력의 `pricescan-collector-0.5.1-webstore.zip` (재빌드는 시각 접미사)
- 확장 프로그램 이름: `PriceScan - AI 감독형 가격 조사`
- 카테고리: `쇼핑`
- 언어: `한국어`
- 스토어 아이콘: `extensions/pricescan-collector/icons/icon-128.png`
- 스크린샷: `artifacts/chrome-webstore/store-assets/pricescan-home-1280x800.png`
- 개인정보 처리방침 URL: `https://pricescan.d2blue.com/pricescan/extension-privacy.html`
- 단일 목적 및 상세 설명: `extensions/pricescan-collector/store-listing-ko.md`
- 권한 사용 사유: `extensions/pricescan-collector/permissions-justification-ko.md`

## 데이터 사용 선언

- 처리 데이터: 사용자가 승인한 네이버·다나와·에누리·쿠팡 화면의 상품명/옵션, 판매처, 가격, 배송비, 상품 링크, 검색어, 승인 시각/진행 상태와 대상 판매상품 ID
- 수집하지 않는 데이터: 인증정보, 비밀번호, 쿠키, 결제정보, 전체 브라우징 기록
- 목적: 사용자가 확인한 가격 비교 정보를 본인의 PriceScan 계정에 반영
- 광고/판매/신용평가/대출 목적 사용: 없음
- 원격 코드: 사용하지 않음

## 게시 전에 필요한 외부 준비

1. `pricescan.d2blue.com`에 현재 프론트엔드를 배포해 개인정보 처리방침 URL이 실제로 열리는지 확인합니다.
2. Chrome Web Store 개발자 계정의 본인 인증과 등록비 결제를 완료합니다.
3. ZIP 업로드 후 스토어 설명, 아이콘, 스크린샷, 권한 사유, 데이터 사용 선언을 입력합니다.
4. 초안 내용을 최종 검토한 뒤 게시 심사에 제출합니다.

## 0.5.1 출시 전 검증 (미완료 항목)

- 각 쇼핑몰의 실제 검색/상품 페이지 DOM에서 후보와 상세 가격 인식 검증
- CleanFile 외장 테스트 프로필의 ChatGPT 연결을 확인한 뒤 사이드 패널 고정/탭 이동 검증
- 로그인·캡차는 사용자 처리, 차단은 건너뛰기, 뒤로 가기, 탭 닫힘, 확장 재시작 복원 검증
- 운영 웹/서버와 확장 프로그램을 함께 업데이트하고 자동 조사→판매상품 연결 검증
- 기존 스토어 이미지 대신 AI 감독형 사이드 패널 스크린샷 준비, 선택적 사이트 접근 권한 사유와 개인정보 안내 게시
- 위 검증 및 사용자 승인 전에는 ZIP 생성만으로 스토어에 제출하거나 게시하지 않음
