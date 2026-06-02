"""
레퍼런스 DB 멀티화 — 식약처(초록배경) + AI Hub(다각도) 둘 다 레퍼런스로 사용
이유: 모델이 배경에 민감 → 한 종류 레퍼런스만 쓰면 다른 배경 사진을 못 맞춤
해결: 약마다 식약처 이미지 + AI Hub 이미지 여러 장을 모두 레퍼런스에 넣음 (재학습 X)
- 식약처 백업본(ref_embeddings_식약처백업.npy)을 베이스로 유지
- 그 위에 AI Hub 임베딩을 추가 entry로 append (같은 약 이름)
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
REFS_PER_DRUG = 3


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

    # ── 베이스: train.py가 방금 현재 모델로 만든 식약처 레퍼런스 (모델 일치 필수) ──
    base_path = OUT / 'ref_embeddings.npy'
    base_embs = np.load(base_path)
    ref_names = json.load(open(OUT / 'ref_names.json', encoding='utf-8'))
    print(f'식약처 베이스: {len(ref_names)}개 ({base_path.name})')

    # ── AI Hub 이름 매칭 (train.py 동일 로직) ──
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
    def match(an):
        if an in mfds_name_set: return an
        b = _base(an)
        if len(b) >= 5 and b[:5] in p5: return p5[b[:5]]
        if len(b) >= 4 and b[:4] in p4: return p4[b[:4]]
        return an

    tf = transforms.Compose([
        transforms.Resize((224, 224)), transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])
    @torch.no_grad()
    def embed1(path):
        try:
            img = Image.open(path).convert('RGB')
            t = tf(img).unsqueeze(0).to(DEVICE)
            return model.get_embedding(t).cpu().numpy()[0]
        except Exception:
            return None

    # ── AI Hub 임베딩 추가 (약당 REFS_PER_DRUG 장) ──
    extra_embs, extra_names = [], []
    groups = list(aihub.groupby('drug_code'))
    for code, grp in tqdm(groups, desc='AI Hub 추가'):
        uname = match(str(grp.iloc[0]['drug_name']))
        for path in grp['image_path'].tolist()[:REFS_PER_DRUG]:
            e = embed1(path)
            if e is not None:
                extra_embs.append(e); extra_names.append(uname)

    new_embs = np.vstack([base_embs, np.array(extra_embs, dtype=np.float32)])
    new_names = list(ref_names) + extra_names
    np.save(OUT / 'ref_embeddings.npy', new_embs.astype(np.float32))
    json.dump(new_names, open(OUT / 'ref_names.json', 'w', encoding='utf-8'), ensure_ascii=False)
    print(f'\n✅ 멀티 레퍼런스 완료!')
    print(f'   식약처 {len(ref_names)} + AI Hub {len(extra_names)} = 총 {len(new_names)}개 레퍼런스')


if __name__ == '__main__':
    main()
