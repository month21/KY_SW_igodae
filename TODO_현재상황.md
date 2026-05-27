# 이거돼? — TODO & 일정 (2026.05.19 기준)

## 완료

- [x] DL 1차 학습 (ArcFace + EfficientNet-B0, 273종)
- [x] Flask 추론 서버 + Vite 프록시 연동
- [x] 앱 하이브리드 파이프라인 (DL → 식약처 DB → Groq 요약)
- [x] Groq 크로스밸리데이션 제거
- [x] OOD 방어 (threshold 0.25)
- [x] ngrok 외부 접속
- [x] 정정하기(Active Learning) 기능 추가
- [x] 식약처 조회 폴백 (drugInfo → pillInfo)
- [x] co_work v0.5.1 푸시 + main PR 생성
- [x] 2차 학습 실행 중 (2000종 웹 크롤링 확대)

---

## TODO

### 이번 주
1. [ ] 2차 학습 완료 확인 → 서버 재시작 → 정확도 테스트
2. [ ] SAM(Segment Anything) 연동 — 여러 약 개별 분리 인식
   - MobileSAM pretrained 모델 적용 (학습 불필요)
   - server.py: 이미지 → SAM 분리 → 각 crop → ArcFace 매칭
   - App.jsx: 이미 PillListCard 있어서 큰 수정 없음
3. [ ] 팀원들 ngrok 테스트 시작 → 정정 데이터 수집 시작

### 다음 주
4. [ ] 3차 학습 — 크롤링 이미지 자동 품질 필터 추가
   - 텍스트만 있는 이미지, 약 상자, 광고 등 자동 제거
   - 약 사진인지 판별하는 간단한 필터 로직
5. [ ] 4차 학습 — SAM crop 이미지를 augmentation에 반영
   - 실제 촬영 환경과 비슷한 데이터로 학습
6. [ ] 정정 데이터 누적분 반영

### 3~4주차
7. [ ] 5~6차 학습 — augmentation 강화 (조명, 배경, 각도)
8. [ ] 정정 데이터 계속 누적 반영
9. [ ] OOD threshold / LR 등 파라미터 미세 조정
10. [ ] 최종 테스트 + 시연 영상 촬영
11. [ ] co_work → main 머지

---

## 일정표

| 날짜 | 할 일 | 예상 정확도 |
|------|-------|------------|
| 5/19 (월) | 2차 학습 실행 중 (2000종) | - |
| 5/20 (화) | 2차 완료 확인 + SAM 연동 시작 | R@1 40~50% |
| 5/21 (수) | SAM 연동 완료 + 팀원 테스트 시작 | 여러 약 분리 가능 |
| 5/22 (목) | 3차 학습 (이미지 품질 필터) | R@1 50~60% |
| 5/23 (금) | 4차 학습 (SAM crop 반영) | R@1 55~65% |
| 5/26 (월) | 5차 학습 (정정 데이터 + augmentation) | R@1 65~75% |
| 5/28 (수) | 6차 학습 (정정 누적) | R@1 70~80% |
| 5/30 (금) | 7차 학습 (파라미터 튜닝) | R@1 75~85% |
| 6/1~ | 최종 조정 + 시연 | 시연 가능 수준 |

---

## 핵심 명령어

```bash
# ML 서버 실행 (학습 끝난 후)
cd ~/Desktop/KY_SW_igodae-co_work/ml
source venv/bin/activate
python3 server.py

# 학습 실행 (새 터미널)
cd ~/Desktop/KY_SW_igodae-co_work/ml
source venv/bin/activate
python3 train.py

# 재학습 전 캐시 삭제
rm ml/data/web_pills.csv
rm -rf ml/data/web_images/

# Vite 개발 서버
npm run dev

# ngrok 터널
ngrok http 3000
```

## 현재 서버 상태

- ML 추론 서버: `localhost:5001` (1차 모델 273종, 학습 중 동시 운영)
- Vite 개발 서버: `localhost:3000`
- ngrok: `https://grimy-paternity-unison.ngrok-free.dev`
- 2차 학습: 진행 중 (에폭 5/40, R@1 36.2%)
