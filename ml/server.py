#!/usr/bin/env python3
"""
이거돼? — DL 모델 추론 서버
학습 완료 후 이 서버를 실행하면 앱에서 /api/model-inference 로 호출 가능

실행: python3 server.py
포트: 5001
"""

import os, json, sys
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
import timm
from flask import Flask, request, jsonify
from flask_cors import CORS
from PIL import Image
from torchvision import transforms
from io import BytesIO
import base64
from pathlib import Path
from mobile_sam import sam_model_registry, SamAutomaticMaskGenerator

app = Flask(__name__)
CORS(app)

# ─── 경로 ───
BASE_DIR   = Path(__file__).parent
OUTPUT_DIR = BASE_DIR / 'output'

# ─── 모델 정의 (train.py와 동일) ───
class PillModel(nn.Module):
    def __init__(self, num_classes, emb_dim=512):
        super().__init__()
        self.backbone = timm.create_model('efficientnet_b0', pretrained=False, num_classes=0)
        self.embedding = nn.Sequential(
            nn.Linear(self.backbone.num_features, emb_dim),
            nn.BatchNorm1d(emb_dim),
        )

    def get_embedding(self, x):
        return F.normalize(self.embedding(self.backbone(x)), dim=1)

# ─── 전역 변수 ───
model = None
ref_embeddings = None
ref_names = None
ood_config = None
transform = None
DEVICE = None
sam_generator = None
yolo_model = None   # YOLO 약 탐지 (SAM 대체 — 여러 약 위치 박스)
ocr_reader = None   # EasyOCR — 알약 각인(글자/숫자) 읽기 (보조 식별)
MATCH_MASK = None   # 매칭 가능 레퍼런스 마스크 (네거티브·조합코드 제외)

# 멀티약(SAM) 튜닝
SINGLE_SKIP_CONF = 0.70   # 전체 이미지가 이 이상으로 매칭되면 단일 약 → SAM 스킵 (속도↑, 2면 오분할 방지)
MULTI_MIN_CONF   = 0.50   # SAM 분할 조각은 이 이상만 약으로 인정 (뒷면·텍스트 쓰레기 조각 제거)

def load_model():
    global model, ref_embeddings, ref_names, ood_config, transform, DEVICE

    # 디바이스
    if torch.backends.mps.is_available():
        DEVICE = torch.device('mps')
    elif torch.cuda.is_available():
        DEVICE = torch.device('cuda')
    else:
        DEVICE = torch.device('cpu')
    print(f'🔧 디바이스: {DEVICE}')

    # 체크포인트 로드
    ckpt_path = OUTPUT_DIR / 'best_model.pth'
    if not ckpt_path.exists():
        print(f'❌ 모델 파일 없음: {ckpt_path}')
        print('   train.py로 학습을 먼저 완료하세요.')
        sys.exit(1)

    checkpoint = torch.load(str(ckpt_path), map_location=DEVICE)
    num_classes = checkpoint['num_classes']
    emb_dim = checkpoint.get('emb_dim', 512)

    model = PillModel(num_classes, emb_dim).to(DEVICE)
    # ArcFace head는 추론에 불필요 → backbone + embedding만 로드
    state = checkpoint['model_state_dict']
    model_keys = {k for k in model.state_dict().keys()}
    filtered = {k: v for k, v in state.items() if k in model_keys}
    model.load_state_dict(filtered, strict=False)
    model.eval()
    print(f'✅ 모델 로드 완료 (클래스: {num_classes}, 임베딩: {emb_dim}차원)')

    # 레퍼런스 DB
    ref_embeddings = np.load(str(OUTPUT_DIR / 'ref_embeddings.npy'))
    with open(str(OUTPUT_DIR / 'ref_names.json'), 'r', encoding='utf-8') as f:
        ref_names = json.load(f)
    print(f'✅ 레퍼런스 DB: {len(ref_names)}개 약품')

    # 매칭 가능 마스크 미리 계산: 네거티브 + 조합(K-코드) 제외
    # 조합 클래스("K-000250-000573-...")는 약 이름이 아니라 코드 → 사용자에게 쓸모없음
    global MATCH_MASK
    import re as _re
    neg = '__NOT_A_PILL__'
    combo_re = _re.compile(r'^K-\d+-\d+')
    MATCH_MASK = np.array([(n != neg) and (combo_re.match(str(n)) is None) for n in ref_names])
    print(f'✅ 매칭 대상: {int(MATCH_MASK.sum())}종 (조합·네거티브 {len(ref_names)-int(MATCH_MASK.sum())}개 제외)')

    # OOD 설정
    ood_path = OUTPUT_DIR / 'ood_config.json'
    if ood_path.exists():
        with open(str(ood_path), 'r', encoding='utf-8') as f:
            ood_config = json.load(f)
        print(f'✅ OOD 설정: threshold={ood_config["threshold"]}')
    else:
        ood_config = {'threshold': 0.45, 'negative_label': '__NOT_A_PILL__'}

    # Transform
    transform = transforms.Compose([
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])

    # MobileSAM 로드 (있으면)
    global sam_generator
    sam_path = OUTPUT_DIR / 'mobile_sam.pt'
    if sam_path.exists():
        try:
            sam = sam_model_registry['vit_t'](checkpoint=str(sam_path))
            sam.to(DEVICE if DEVICE.type != 'mps' else torch.device('cpu'))
            sam.eval()
            sam_generator = SamAutomaticMaskGenerator(
                sam,
                points_per_side=16,
                pred_iou_thresh=0.86,
                stability_score_thresh=0.92,
                min_mask_region_area=1000,
            )
            print('✅ MobileSAM 로드 완료 (멀티약 분리 가능)')
        except Exception as e:
            print(f'⚠️ MobileSAM 로드 실패: {e}')
            sam_generator = None
    else:
        print('ℹ️ MobileSAM 가중치 없음 — 단일 약 모드만 사용')

    # YOLO 약 탐지 로드 (SAM 대체 — 여러 약 위치 박스)
    global yolo_model
    yolo_path = OUTPUT_DIR / 'yolo_pill' / 'weights' / 'best.pt'
    if yolo_path.exists():
        try:
            from ultralytics import YOLO
            yolo_model = YOLO(str(yolo_path))
            print('✅ YOLO 약 탐지 로드 완료 (멀티약 = YOLO 박스 → ArcFace)')
        except Exception as e:
            print(f'⚠️ YOLO 로드 실패: {e}')
            yolo_model = None
    else:
        print('ℹ️ YOLO 가중치 없음 — SAM 폴백')

    # EasyOCR 로드 (알약 각인 읽기 — 보조 식별)
    global ocr_reader
    try:
        import easyocr
        ocr_reader = easyocr.Reader(['en'], gpu=False)   # 각인은 영문/숫자, CPU로 안정
        print('✅ EasyOCR 로드 완료 (각인 읽기)')
    except Exception as e:
        print(f'⚠️ EasyOCR 로드 실패: {e}')
        ocr_reader = None


import re as _re_ocr
_OCR_NOISE = {'druginfo', 'drug', 'info', 'mg', 'mm'}

def read_imprint(img):
    """알약 각인(글자/숫자) 추출 — 배경 워터마크 노이즈 필터. 실패 시 빈 문자열."""
    if ocr_reader is None:
        return ''
    try:
        import numpy as _np
        toks = ocr_reader.readtext(_np.array(img), detail=0)
        cands = []
        for t in toks:
            s = _re_ocr.sub(r'[^A-Za-z0-9]', '', str(t)).strip()
            if not (2 <= len(s) <= 10):
                continue
            if s.lower() in _OCR_NOISE:
                continue
            if _re_ocr.fullmatch(r'\d{3,}', s):   # 긴 숫자(워터마크 코드) 제외
                continue
            cands.append(s)
        # 글자 포함 토큰 우선, 길이순
        cands.sort(key=lambda s: (any(c.isalpha() for c in s), len(s)), reverse=True)
        return cands[0] if cands else ''
    except Exception:
        return ''


@app.route('/api/model-inference', methods=['POST', 'OPTIONS'])
def inference():
    if request.method == 'OPTIONS':
        return '', 200

    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({'error': 'image (base64) 필드 필요'}), 400

        img_b64 = data['image']
        if ',' in img_b64:
            img_b64 = img_b64.split(',', 1)[1]

        img_bytes = base64.b64decode(img_b64)
        img = Image.open(BytesIO(img_bytes)).convert('RGB')

        result = analyze_single_crop(img)
        threshold = ood_config.get('threshold', 0.45)
        # 각인 OCR(~1초)은 인식이 애매할 때만 (고신뢰는 불필요 → 속도↑)
        conf = result['confidence'] if result else 0.0
        imprint = read_imprint(img) if (result is not None and conf < 0.85) else ''

        if result is None:
            return jsonify({
                'success': True,
                'isPill': False,
                'confidence': 0.0,
                'threshold': threshold,
                'imprint': imprint,
                'message': '약으로 인식할 수 없습니다',
                'pills': [],
            })

        return jsonify({
            'success': True,
            'isPill': True,
            'confidence': result['confidence'],
            'threshold': threshold,
            'imprint': imprint,
            'pills': result['pills'],
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500


def analyze_single_crop(img):
    """단일 이미지 → ArcFace 매칭 (내부 헬퍼)"""
    img_tensor = transform(img).unsqueeze(0).to(DEVICE)
    with torch.no_grad():
        query = model.get_embedding(img_tensor).cpu().numpy()

    sims = np.dot(ref_embeddings, query.T).flatten()
    neg_label = ood_config.get('negative_label', '__NOT_A_PILL__')
    sims_pill = sims.copy()
    sims_pill[~MATCH_MASK] = -1   # 네거티브 + 조합(K-코드) 제외 → 쓸모없는 코드/비약 매칭 방지

    top1_sim = float(sims_pill.max())
    top5_idxs = np.argsort(sims_pill)[::-1][:5]
    threshold = ood_config.get('threshold', 0.45)

    if top1_sim < threshold:
        return None

    results = []
    for idx in top5_idxs:
        name = ref_names[idx]
        if not MATCH_MASK[idx]:
            continue
        results.append({
            'drugName': name,
            'similarity': float(sims[idx]),
        })
        if len(results) >= 5:
            break

    return {
        'confidence': top1_sim,
        'pills': results,
    }


@app.route('/api/model-inference/multi', methods=['POST', 'OPTIONS'])
def inference_multi():
    """여러 약 동시 인식 — YOLO로 약 박스 탐지 후 각 박스 ArcFace 매칭 (SAM 대체)"""
    if request.method == 'OPTIONS':
        return '', 200

    if yolo_model is None:
        return jsonify({'error': 'YOLO 탐지 모델이 로드되지 않았습니다'}), 503

    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({'error': 'image (base64) 필드 필요'}), 400

        img_b64 = data['image']
        if ',' in img_b64:
            img_b64 = img_b64.split(',', 1)[1]

        img_bytes = base64.b64decode(img_b64)
        img = Image.open(BytesIO(img_bytes)).convert('RGB')
        img_np = np.array(img)
        H, W = img_np.shape[:2]

        # ── YOLO로 약 위치 박스 탐지 ──
        boxes = []
        try:
            yres = yolo_model.predict(img_np, conf=0.35, iou=0.5, verbose=False, device='cpu')
            if yres and len(yres[0].boxes) > 0:
                boxes = yres[0].boxes.xyxy.cpu().numpy().tolist()
        except Exception as e:
            print(f'⚠️ YOLO 탐지 오류: {e}')

        # 못 찾으면 전체 이미지를 1개 박스로 (단일 약 폴백)
        if not boxes:
            boxes = [[0, 0, W, H]]

        pill_results = []
        for i, box in enumerate(boxes[:8]):
            x1, y1, x2, y2 = [int(v) for v in box[:4]]
            pad = int(max(x2 - x1, y2 - y1) * 0.08)
            cx1 = max(0, x1 - pad); cy1 = max(0, y1 - pad)
            cx2 = min(W, x2 + pad); cy2 = min(H, y2 + pad)
            crop = img.crop((cx1, cy1, cx2, cy2))

            result = analyze_single_crop(crop)
            if result is None or result['confidence'] < MULTI_MIN_CONF:
                continue

            pill_results.append({
                'index': i,
                'bbox': [cx1, cy1, cx2, cy2],
                'confidence': result['confidence'],
                'pills': result['pills'],
            })

        return jsonify({
            'success': True,
            'mode': 'yolo_multi',
            'segmentsFound': len(boxes),
            'pillsIdentified': len(pill_results),
            'results': pill_results,
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/model-inference/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok',
        'model_loaded': model is not None,
        'ref_count': len(ref_names) if ref_names else 0,
        'ood_threshold': ood_config.get('threshold', 0.45) if ood_config else None,
        'sam_loaded': sam_generator is not None,
    })


if __name__ == '__main__':
    load_model()
    print('\n🚀 추론 서버 시작: http://localhost:5001')
    print('   /api/model-inference      — POST (이미지 분석)')
    print('   /api/model-inference/health — GET  (상태 확인)')
    app.run(host='0.0.0.0', port=5001, debug=False)
