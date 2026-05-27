# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Vite dev server on port 3000 (host exposed). MFDS/Groq 프록시 미들웨어가 Vite 플러그인으로 자동 실행됨.
- `npm run build` — production bundle into `dist/`.
- `npm run preview` — preview the built bundle. Note: `preview` does NOT run the Vite middleware proxies, so 식약처/Groq API calls will 404 unless you deploy to Vercel (which provides serverless functions in `api/`).

### ML pipeline (optional, local only)

```bash
cd ml
pip install -r requirements.txt   # or pill-classifier/requirements.txt
python3 train.py                   # ~4–6 hours; writes output/best_model.pth + ref_embeddings.npy
python3 server.py                  # Flask on :5001; Vite proxies it at /api/model-inference
```

`ml/` and `pill-classifier/` are parallel copies of the same pipeline (EfficientNet-B0 + ArcFace metric learning). When the server is not running, `fetchModelInference()` returns `null` and the app falls back to Groq Vision automatically — the ML server is **never required** to run the web app.

There is no linter, test runner, or type-checker configured. Don't claim to "run tests" — they don't exist.

## Architecture

This is a single-page React app for AI-driven pill identification. The entire UI is one file: `src/App.jsx` (~1900 lines). Views (`HomeView`, `CameraView`, `ChatView`, `HistoryView`, `AdminView`, `OnboardingSlides`) are functions inside that file, switched by state in the top-level `App` component (the default export at the bottom). When adding a screen, follow this same pattern rather than splitting into separate files unless the user asks.

### Data flow for a pill analysis

1. User captures/uploads an image in `CameraView` or via file input.
2. **DL model first** — `fetchModelInference()` calls `MODEL_PROXY` (`/api/model-inference`). Three outcomes:
   - Not running → `null` → skip to step 3.
   - `isPill: false` → OOD rejection, stop early.
   - `confidence ≥ 0.75` → skip Groq, go straight to step 4.
   - `confidence 0.45–0.75` → continue to step 3 for Groq cross-validation; DL confidence wins ties.
3. Image → **Groq Vision** (`GROQ_VISION_MODEL`, Llama 4 Scout) via `/api/groq-proxy` with a structured prompt that runs STEP1 (각인/imprint) → STEP2 (외형/shape) → STEP3 (종합 추론). The order is deliberate and was fixed in a prior commit — don't reorder.
4. Vision result → **식약처 (MFDS) APIs** via `/api/mfds-proxy`:
   - `endpoint=pillInfo` — 낱알식별 (color/shape/imprint lookup)
   - `endpoint=drugInfo` — 의약품 개요 (efficacy, dosage, warnings)
   - `endpoint=permission` — 제품허가 (prescription class, ingredients, expiry)
5. Long MFDS text fields are passed through `summarizeMfdsText()` which calls Groq (`GROQ_MODEL`, Llama 3.3 70B) to compress to ≤2 sentences for display.
6. Result + image + symptom are logged to **Firestore** at `artifacts/${APP_ID}/public/data/analysis_logs` (path built by `LOGS_PATH()`). Auth is anonymous.
7. Low-confidence results route to a "do not take" safety branch with a link to the pharmacist community (`COMMUNITY_URL`) — preserve this gate; bypassing it has been pushed back on before.

DUR APIs (`DUR_ENDPOINTS`: 병용금기/임부금기/노인주의/효능군중복) are defined but called directly against `apis.data.go.kr`, not through the proxy.

### Server proxies — Groq + MFDS

**모든 외부 API 호출은 서버리스 프록시 경유.** 브라우저 직접 호출 시 CORS 차단됨. 각 프록시는 Vercel 서버리스 함수(prod)와 Vite 미들웨어(dev) 두 벌로 유지된다.

| API | Prod (Vercel) | Dev (Vite) | 경로 |
|-----|---------------|------------|------|
| Groq (Vision + Chat) | `api/groq-proxy.js` | `groqDevProxy` in `vite.config.js` | `POST /api/groq-proxy` |
| 식약처 (MFDS) | `api/mfds-proxy.js` | `mfdsDevProxy` in `vite.config.js` | `GET /api/mfds-proxy?endpoint=...` |
| DL 모델 추론 | *(not deployed)* | `modelDevProxy` in `vite.config.js` | `POST /api/model-inference` |

The DL model proxy forwards to `localhost:5001` (ml/server.py). If the server is not running, it returns `503 { fallback: true }` and the client gracefully falls back to Groq. There is no Vercel serverless function for it — it is dev/local only.

**When changing one, change both.** Groq 프록시는 요청 body를 그대로 포워딩하고 서버 환경변수 `GROQ_API_KEY`로 인증. MFDS 프록시는 `endpoint` 파라미터로 허용된 API만 라우팅하고 `serviceKey`를 서버에서 주입.

클라이언트(App.jsx)에는 **API 키가 전혀 없어야 한다.** `VITE_` prefix 키를 직접 호출하는 코드가 생기면 CORS 문제가 재발하고, 키가 번들에 노출된다.

### Environment variables

**Client-bundled** (`VITE_` prefix, `import.meta.env`):
- `VITE_FIREBASE_*` (6개: API_KEY, AUTH_DOMAIN, PROJECT_ID, STORAGE_BUCKET, MESSAGING_SENDER_ID, APP_ID)
- `VITE_APP_ID` — Firestore 경로 식별자

**Server-only** (Vercel env vars, `VITE_` prefix 없음 → 클라이언트 번들에 포함 안 됨):
- `GROQ_API_KEY` — Groq API 인증 (groq-proxy가 사용)
- `MFDS_API_KEY` — 식약처 API 인증 (mfds-proxy가 사용)

`VITE_GROQ_API_KEY`는 의도적으로 제거됨 — 이전에 클라이언트 번들에 키가 노출되고, Groq의 CORS 차단으로 어차피 동작하지 않았음. 같은 이유로 `VITE_MFDS_API_KEY`도 fallback으로만 존재 (서버 전용 `MFDS_API_KEY`가 우선).

See `.env.example` for the full list.

### Admin entry

The admin dashboard (`AdminView`) is reached by tapping the logo 7 times on the home screen (`onLogoTap`). There is no auth gate beyond that — it's obscurity, not security. Don't add a "more discoverable" entry without asking.

## Conventions

- Korean is the primary UI and comment language. Match the existing tone when editing strings.
- Models are pinned via constants at the top of `App.jsx` (`GROQ_MODEL`, `GROQ_VISION_MODEL`). Change them there, not inline.
- `safeFetchGroq` already handles 429/5xx with exponential backoff — reuse it instead of writing new retry logic.
- All external API calls go through `/api/*` proxies. Never call `api.groq.com` or `apis.data.go.kr` directly from client code.
- **커밋 시 `Co-Authored-By` 줄을 절대 넣지 않는다.** Claude 이름을 커밋에 남기지 말 것.
