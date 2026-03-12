# 이거돼? 💊 — AI 기반 약물 판독 & 복약 가이드

> 약 사진 한 장으로 위염 환자 맞춤 복약 정보를 즉시 확인하세요

![이거돼 미리보기](https://via.placeholder.com/480x240/0f766e/ffffff?text=이거돼%3F+App+Preview)

## ✨ 주요 기능

| 기능 | 설명 |
|------|------|
| 📸 **실시간 약품 판독** | 카메라 또는 갤러리로 약 사진을 찍으면 AI가 즉시 성분/효능 분석 |
| 🏥 **위염 맞춤 분석** | 기저질환(위염 등)에 따른 복용 적합성 및 위장 영향 점수 제공 |
| 💬 **AI 약사 채팅** | 분석 결과를 바탕으로 Gemini AI와 실시간 의약 상담 |
| 📋 **분석 기록** | Firebase Firestore에 분석 이력 자동 저장 및 조회 |
| 🔐 **익명 인증** | Firebase 익명 로그인으로 회원가입 없이 개인화 기능 제공 |

## 🛠️ 기술 스택

```
Frontend:   React 18 + Vite + Tailwind CSS + Lucide React
Backend:    Firebase (Auth, Firestore)
AI Engine:  Google Gemini 2.5 Flash Preview (Vision + Chat)
```

## 🚀 빠른 시작

### 1. 저장소 클론

```bash
git clone https://github.com/your-username/igeordwae.git
cd igeordwae
npm install
```

### 2. 환경변수 설정

```bash
cp .env.example .env
```

`.env` 파일을 열고 아래 값을 입력하세요:

#### Gemini API 키 발급
1. [Google AI Studio](https://aistudio.google.com/app/apikey) 접속
2. `Create API key` 클릭
3. `.env`의 `VITE_GEMINI_API_KEY`에 입력

#### Firebase 설정
1. [Firebase Console](https://console.firebase.google.com) 접속
2. 새 프로젝트 생성 (이름: `igeordwae` 권장)
3. **Authentication** → 로그인 방법 → 익명 **활성화**
4. **Firestore Database** → 데이터베이스 만들기 → 테스트 모드 선택
5. 프로젝트 설정 → 웹 앱 추가 → SDK 구성 정보를 `.env`에 입력

#### Firestore 보안 규칙 설정
Firebase Console → Firestore → 규칙 탭에 아래 규칙 적용:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /artifacts/{appId}/public/data/{collection}/{document} {
      allow read, write: if request.auth != null;
    }
  }
}
```

### 3. 개발 서버 실행

```bash
npm run dev
# http://localhost:3000 에서 확인
```

### 4. 빌드 & 배포

```bash
npm run build
# dist/ 폴더를 Firebase Hosting, Vercel, Netlify 등에 배포
```

#### Firebase Hosting 배포 (권장)
```bash
npm install -g firebase-tools
firebase login
firebase init hosting  # dist 폴더 선택, SPA 설정 Yes
npm run build
firebase deploy
```

## 📁 프로젝트 구조

```
igeordwae/
├── src/
│   ├── App.jsx         # 메인 앱 (단일 파일 컴포넌트)
│   ├── main.jsx        # React 진입점
│   └── index.css       # 글로벌 스타일 (Tailwind + 커스텀)
├── public/
│   └── favicon.svg
├── index.html
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── .env.example        # 환경변수 템플릿
└── package.json
```

## 🏗️ 아키텍처

```
사용자 (카메라/갤러리)
    ↓ Base64 이미지
App.jsx (React State)
    ↓ Vision Prompt
Gemini 2.5 Flash Vision API
    ↓ Structured JSON
ResultCard (분석 결과 UI)
    ↓ 저장
Firestore (분석 로그)

사용자 질문
    ↓
ChatView → Gemini Chat API
    ↓
AI 약사 응답
```

## 📋 Firestore 데이터 스키마

```
artifacts/{appId}/public/data/analysis_logs/{docId}
├── userId: string          # 익명 사용자 UID
├── statusCode: string      # safe | caution | danger | unidentified
├── statusText: string      # 약리 분류 설명
├── summary: string         # 약품명
├── gastritisImpact: number # 위염 영향 점수 (1-10)
├── userConditions: string  # 사용자 기저질환
└── createdAt: timestamp    # 저장 시각
```

## ⚠️ 주의사항

- 이 앱의 분석 결과는 **참고용**이며 의학적 진단을 대체하지 않습니다
- 중요한 의약 결정은 반드시 **의사/약사와 상담**하세요
- API 키를 `.env` 파일에만 저장하고 GitHub에 절대 커밋하지 마세요

## 🤝 기여 방법

1. Fork this repository
2. Create feature branch: `git checkout -b feature/awesome-feature`
3. Commit changes: `git commit -m 'feat: add awesome feature'`
4. Push to branch: `git push origin feature/awesome-feature`
5. Open a Pull Request

## 📄 라이선스

MIT License — 자유롭게 사용, 수정, 배포 가능합니다.

---

<p align="center">Made with ❤️ for 위염 환자분들</p>
