"""
레퍼런스 DB 재생성 — 식약처 공식사진 → AI Hub 다각도 이미지로 교체
문제: 모델은 AI Hub로 학습됐는데 레퍼런스는 식약처 공식사진 → 실제 폰 사진이 안 맞음
해결: AI Hub 이미지가 있는 약은 그 임베딩으로 교체 (재학습 X, 임베딩만 재생성)
- ref_names.json 순서/내용은 그대로 유지 (서버 호환)
- ref_embeddings.npy 만 갱신 (AI Hub 있으면 교체, 없으면 기존 유지)
"""
import json, re
from pathlib import Path
import numpy as np
import pandas as pd
import torch
import torch.nn as nn
import torch.nn.functional as F
import timm
from PIL import Image
from torchvision import transforms
from collections import defaultdict
from tqdm import tqdm

ML = Path(__file__).parent
OUT = ML / 'output'
DEVICE = torch.device('mps') if torch.backends.mps.is_available() else torch.device('cpu')


class PillModel(nn.Module):
    def __init__(self, num_classes, emb_dim=512):
        super().__init__()
        self.backbone = timm.create_model('efficientnet_b0', pretrained=False, num_classes=0)
        self.embedding = nn.Sequential(nn.Linear(self.backbone.num_features, emb_dim), nn.BatchNorm1d(emb_dim))
    def get_embedding(self, x):
        return F.normalize(self.embedding(self.backbone(x)), dim=1)


def main():
    print(f'디바이스: {DEVICE}')
    ckpt = torch.load(str(OUT / 'best_model.pth'), map_location=DEVICE)
    model = PillModel(ckpt['num_classes'], ckpt.get('emb_dim', 512)).to(DEVICE)
    state = ckpt['model_state_dict']
    keys = set(model.state_dict().keys())
    model.load_state_dict({k: v for k, v in state.items() if k in keys}, strict=False)
    model.eval()
    print(f'모델 로드: {ckpt["num_classes"]}클래스')

    ref_names = json.load(open(OUT / 'ref_names.json', encoding='utf-8'))
    old_embs = np.load(OUT / 'ref_embeddings.npy')
    print(f'기존 레퍼런스: {len(ref_names)}개')

    # ── AI Hub 약 이름 → 이미지 매핑 (train.py의 match_mfds_name 동일 로직) ──
    aihub = pd.read_csv(ML / 'data' / 'aihub_pills.csv')
    mfds = pd.read_csv(ML / 'data' / 'pills.csv')
    mfds_names = list(mfds['item_name'].dropna().unique())
    mfds_name_set = set(mfds_names)
    def _base(n):
        return re.sub(r'[\s\d]|밀리그램|mg|ml|\(.*\)|/.*$', '', str(n)).strip()
    p5, p4 = {}, {}
    for mn in mfds_names:
        b = _base(mn)
        if len(b) >= 5: p5.setdefault(b[:5], mn)
        if len(b) >= 4: p4.setdefault(b[:4], mn)
    def match(aihub_name):
        if aihub_name in mfds_name_set: return aihub_name
        b = _base(aihub_name)
        if len(b) >= 5 and b[:5] in p5: return p5[b[:5]]
        if len(b) >= 4 and b[:4] in p4: return p4[b[:4]]
        return aihub_name

    # 통일이름 → AI Hub 이미지 경로들
    name_to_imgs = defaultdict(list)
    for code, grp in aihub.groupby('drug_code'):
        uname = match(str(grp.iloc[0]['drug_name']))
        name_to_imgs[uname].extend(grp['image_path'].tolist())
    print(f'AI Hub 통일이름: {len(name_to_imgs)}개')

    tf = transforms.Compose([
        transforms.Resize((224, 224)), transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])
    REFS_PER_DRUG = 3  # 약당 AI Hub 각도 몇 장 평균낼지

    @torch.no_grad()
    def embed_avg(paths):
        embs = []
        for p in paths[:REFS_PER_DRUG]:
            try:
                img = Image.open(p).convert('RGB')
                t = tf(img).unsqueeze(0).to(DEVICE)
                embs.append(model.get_embedding(t).cpu().numpy()[0])
            except Exception:
                continue
        if not embs:
            return None
        v = np.mean(embs, axis=0)
        n = np.linalg.norm(v)
        return (v / n) if n > 0 else None

    new_embs = old_embs.copy()
    replaced = 0
    for i, name in enumerate(tqdm(ref_names, desc='재생성')):
        imgs = name_to_imgs.get(name)
        if not imgs:
            continue                       # AI Hub 없음 → 기존(식약처) 임베딩 유지
        v = embed_avg(imgs)
        if v is not None:
            new_embs[i] = v
            replaced += 1

    np.save(OUT / 'ref_embeddings.npy', new_embs.astype(np.float32))
    print(f'\n✅ 완료! {replaced}개 약을 AI Hub 임베딩으로 교체 (나머지 {len(ref_names)-replaced}개는 식약처 유지)')
    print(f'   저장: {OUT/"ref_embeddings.npy"}')


if __name__ == '__main__':
    main()
