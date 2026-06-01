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

        if result is None:
            return jsonify({
                'success': True,
                'isPill': False,
                'confidence': 0.0,
                'threshold': threshold,
                'message': '약으로 인식할 수 없습니다',
                'pills': [],
            })

        return jsonify({
            'success': True,
            'isPill': True,
            'confidence': result['confidence'],
            'threshold': threshold,
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
    """여러 약 동시 인식 — SAM으로 분리 후 각각 ArcFace 매칭"""
    if request.method == 'OPTIONS':
        return '', 200

    if sam_generator is None:
        return jsonify({'error': 'MobileSAM이 로드되지 않았습니다'}), 503

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

        # ── 작업4: 단일 약 빠른 판정 — 전체 이미지 1회 추론. 명확히 1개면 SAM 스킵 ──
        # (SAM 십수 초 절약 + 식약처 2면 이미지 오분할/쓰레기 조각 차단)
        whole = analyze_single_crop(img)
        if whole and whole['confidence'] >= SINGLE_SKIP_CONF:
            return jsonify({
                'success': True,
                'mode': 'single_fast',
                'segmentsFound': 1,
                'pillsIdentified': 1,
                'results': [{
                    'index': 0,
                    'bbox': [0, 0, int(img_np.shape[1]), int(img_np.shape[0])],
                    'confidence': whole['confidence'],
                    'pills': whole['pills'],
                }],
            })

        masks = sam_generator.generate(img_np)

        # ── 작업B: 약 모양 기하 필터 — 배경·그림자·뒷면 띠 같은 비(非)약 조각 제거 ──
        total_area = img_np.shape[0] * img_np.shape[1]
        def _pill_like(m):
            a = m['area']
            bx, by, bw, bh = m['bbox']
            if not (total_area * 0.02 < a < total_area * 0.80):
                return False              # 너무 작거나(부스러기) 너무 큼(전체 배경)
            if bw < 8 or bh < 8:
                return False
            if max(bw, bh) / min(bw, bh) > 3.5:
                return False              # 지나치게 길쭉 = 약 아님(배경 띠/모서리)
            if a < bw * bh * 0.45:
                return False              # bbox 대비 채움률 낮음 = 불규칙(그림자/배경)
            return True
        masks = [m for m in masks if _pill_like(m)]
        masks = sorted(masks, key=lambda x: x['area'], reverse=True)

        # 겹치는 마스크 제거 (IoU > 50%면 큰 쪽만 남김)
        filtered = []
        for m in masks:
            bx, by, bw, bh = m['bbox']
            keep = True
            for f in filtered:
                fx, fy, fw, fh = f['bbox']
                ix1, iy1 = max(bx, fx), max(by, fy)
                ix2, iy2 = min(bx+bw, fx+fw), min(by+bh, fy+fh)
                inter = max(0, ix2-ix1) * max(0, iy2-iy1)
                union = bw*bh + fw*fh - inter
                if union > 0 and inter / union > 0.5:
                    keep = False
                    break
            if keep:
                filtered.append(m)
        masks = filtered[:6]

        pill_results = []
        for i, mask_data in enumerate(masks):
            bbox = mask_data['bbox']  # [x, y, w, h]
            x, y, w, h = [int(v) for v in bbox]

            pad = int(max(w, h) * 0.1)
            x1 = max(0, x - pad)
            y1 = max(0, y - pad)
            x2 = min(img_np.shape[1], x + w + pad)
            y2 = min(img_np.shape[0], y + h + pad)

            crop = img.crop((x1, y1, x2, y2))

            result = analyze_single_crop(crop)
            # 작업6: 저신뢰 조각(뒷면·텍스트 등 쓰레기) 제거 — 멀티 인정 기준 상향
            if result is None or result['confidence'] < MULTI_MIN_CONF:
                continue

            pill_results.append({
                'index': i,
                'bbox': [x1, y1, x2, y2],
                'confidence': result['confidence'],
                'pills': result['pills'],
            })

        return jsonify({
            'success': True,
            'mode': 'multi',
            'segmentsFound': len(masks),
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
