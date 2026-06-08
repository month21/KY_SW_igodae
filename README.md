# 이거돼? 💊

> AI 기반 약품 판독 & 복약 가이드 앱

약 사진 한 장으로 성분, 효능, 주의사항을 바로 확인할 수 있는 서비스입니다.

배포 URL:  https://ky-sw-igodae.vercel.app/
---

## 주요 기능

### 📸 약품 이미지 분석
- 카메라 촬영 또는 갤러리에서 사진 업로드
- Groq Vision AI(Llama 4)가 알약 색상, 모양, 각인, 제형을 자동 인식
- 여러 알약을 한 번에 촬영해도 각각 개별 분석

### 🏥 식약처 공식 데이터 연동
- **낱알식별 API** — 색상/모양/각인으로 약품 검색
- **의약품 개요정보 API** — 효능, 복용법, 주의사항, 부작용, 상호작용
- **의약품 제품허가 API** — 전문/일반 구분, 주성분, 허가일자, 저장방법, 유효기간

### 🤖 AI 약사 채팅
- 분석된 약품을 바탕으로 궁금한 점을 바로 질문 가능
- 식전/식후 복용 여부, 다른 약과의 병용 가능 여부, 부작용 등 안내
- Groq API(Llama 3.3 70B) 기반 자연어 응답

### 📊 종합 분석
- 여러 알약을 동시에 복용할 때의 상호작용 분석
- 사용자 증상 입력 시 약품과의 연관성 비교
- 신뢰도 점수로 분석 정확도 표시

### 📋 분석 히스토리
- Firebase Firestore에 분석 기록 자동 저장
- 이전 분석 결과 언제든지 다시 확인 가능
- 익명 로그인으로 별도 회원가입 없이 사용

### 🔐 관리자 대시보드
- 총 분석 횟수, AI 인식 정확도 통계
- 안전/주의/위험 약품 분류 현황
- 로고 5회 탭으로 진입하는 숨겨진 접근 방식

### 📱 설치 및 실행 방법
- 갤럭시: 앱 배포 후 앱스토어에서 다운 가능/ 링크 사용
- 아이폰: 사파리 접속 -> 웹사이트 공유 -> 홈 화면 추가 -> 앱처럼 사용 가능

---
## 사용 방법

<img width="792" height="586" alt="image" src="https://github.com/user-attachments/assets/569fbffd-4c6d-432c-bbd6-e07fa0fc9b4c" />

화면과 같이 로그인 실행

<img width="487" height="978" alt="image" src="https://github.com/user-attachments/assets/9650681d-c9f7-45ac-a21d-b3b0544be020" />

증상 입력

<img width="484" height="983" alt="image" src="https://github.com/user-attachments/assets/a40a0e94-a552-4065-9efc-3ae465b73293" />


촬영 안내 문구 제시와 동시에 단일 약 인지 여러 약인지 선택 후 사진 업로드 또는 촬영


<img width="486" height="982" alt="image" src="https://github.com/user-attachments/assets/64ec23ab-14d4-47b8-b03e-78acf56d3b59" />
<img width="473" height="977" alt="image" src="https://github.com/user-attachments/assets/00b7c594-6910-4e40-b201-416c885f3729" />
<img width="486" height="984" alt="image" src="https://github.com/user-attachments/assets/506f6c90-e157-447b-a4b1-d248e971d077" />

위과 같이 분석 결과 도출

<img width="481" height="982" alt="image" src="https://github.com/user-attachments/assets/4dbe91b6-09ca-406a-b6ba-fa0d6e3ec956" />

분석 결과에서 AI 약사 채팅 버튼을 클릭하면 위와 같이 채팅 가능

<img width="485" height="981" alt="image" src="https://github.com/user-attachments/assets/12aa8da8-9c4d-4f90-8af9-00880bd27c3e" />

위와 같이 히스토리로 과거 어느 약을 검색 했는지 확인 가능

<img width="484" height="982" alt="image" src="https://github.com/user-attachments/assets/ff3a7633-0c10-4973-80ea-68736b706a34" />

위와 같이 과거 검색했던 결과를 다시 보기 가능

---
## 기술 스택

| 분류 | 기술 |
|------|------|
| 프론트엔드 | React, Vite, Tailwind CSS |
| AI | Groq API (Llama 4 Scout Vision, Llama 3.3 70B) |
| 공공 데이터 | 식품의약품안전처 API (낱알식별, 의약품개요, 제품허가) |
| 백엔드/DB | Firebase Auth, Firestore |
| 배포 | Vercel |

---

## 팀 구성

| 역할 | 인원 |
|------|------|
| PM | 1명 |
| CM | 1명 |
| QA | 1명 |
| ENG | 2명 |

건양대학교 대전캠퍼스 한학기 프로젝트
