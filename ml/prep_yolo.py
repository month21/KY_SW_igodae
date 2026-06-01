"""
AI Hub COCO 바운딩박스 → YOLO 형식 변환 + 데이터셋 구성
- 라벨: TL_*.zip(단일+조합)의 annotations[].bbox(COCO [x,y,w,h] 절대좌표)
- 이미지: data/aihub_images/ (추출해둔 전체 사진, 976x1280)
- 출력: data/yolo/{images,labels}/{train,val}/ + pill.yaml
- 클래스: "pill" 1개 (위치만 탐지, 약 식별은 ArcFace가 따로)
이미지는 복사 대신 심볼릭 링크 (200K장 공간 절약)
"""
import json, zipfile, random, os
from pathlib import Path
from collections import defaultdict
from tqdm import tqdm

ML = Path(__file__).parent
AIHUB = ML / 'data' / 'aihub_pills' / '166.약품식별 인공지능 개발을 위한 경구약제 이미지 데이터' / '01.데이터' / '1.Training'
TL_SINGLE = AIHUB / '라벨링데이터' / '단일경구약제 5000종'
TL_COMBO  = AIHUB / '라벨링데이터' / '경구약제조합 5000종'
IMG_DIR = ML / 'data' / 'aihub_images'
OUT = ML / 'data' / 'yolo'

MAX_PER_DRUG = 6   # 약(폴더)당 최대 이미지 수 — 1클래스 탐지엔 충분, 학습 빠름
VAL_RATIO = 0.1
random.seed(42)


def main():
    print('=' * 60)
    print('  YOLO 데이터셋 구성 (AI Hub 박스 → YOLO)')
    print('=' * 60)

    # 1) 추출된 이미지 인덱스 (파일명 → 실제 경로)
    print('\n📁 추출 이미지 인덱싱...')
    img_index = {}
    for p in IMG_DIR.rglob('*.png'):
        img_index[p.name] = p
    print(f'  이미지: {len(img_index):,}장')

    # 2) 라벨 zip에서 파일명 → (W, H, [bbox...]) 수집
    print('\n📋 라벨(박스) 수집...')
    tl_zips = sorted(list(TL_SINGLE.glob('TL_*_단일.zip')) + list(TL_COMBO.glob('TL_*_조합.zip')))
    labels = {}  # filename -> (W, H, [(x,y,w,h), ...])
    for tz in tqdm(tl_zips, desc='  라벨 스캔'):
        try:
            with zipfile.ZipFile(tz) as zf:
                for fn in zf.namelist():
                    if not fn.endswith('.json'):
                        continue
                    try:
                        d = json.loads(zf.read(fn))
                        img = d.get('images', [{}])[0]
                        name = img.get('file_name') or img.get('imgfile')
                        W, H = img.get('width'), img.get('height')
                        if not name or not W or not H:
                            continue
                        boxes = [a['bbox'] for a in d.get('annotations', []) if a.get('bbox')]
                        if boxes:
                            labels[name] = (W, H, boxes)
                    except Exception:
                        continue
        except Exception:
            continue
    print(f'  박스 있는 라벨: {len(labels):,}개')

    # 3) 이미지 ↔ 라벨 매칭 + 약(폴더)당 샘플링
    print('\n🔗 매칭 + 샘플링...')
    per_drug = defaultdict(int)
    pairs = []  # (img_path, [(x,y,w,h)], W, H)
    matched_names = [n for n in labels if n in img_index]
    random.shuffle(matched_names)
    for name in matched_names:
        img_path = img_index[name]
        drug = img_path.parent.name
        if per_drug[drug] >= MAX_PER_DRUG:
            continue
        W, H, boxes = labels[name]
        pairs.append((img_path, boxes, W, H))
        per_drug[drug] += 1
    print(f'  학습 쌍: {len(pairs):,}장 ({len(per_drug):,}종)')

    # 4) train/val 분리 + 디렉토리 구성 (심볼릭 링크)
    random.shuffle(pairs)
    n_val = int(len(pairs) * VAL_RATIO)
    splits = {'val': pairs[:n_val], 'train': pairs[n_val:]}

    for sp in ('train', 'val'):
        (OUT / 'images' / sp).mkdir(parents=True, exist_ok=True)
        (OUT / 'labels' / sp).mkdir(parents=True, exist_ok=True)

    for sp, items in splits.items():
        for img_path, boxes, W, H in tqdm(items, desc=f'  {sp} 쓰기'):
            stem = img_path.stem
            # 이미지 심볼릭 링크
            link = OUT / 'images' / sp / img_path.name
            if not link.exists():
                try:
                    link.symlink_to(img_path.resolve())
                except FileExistsError:
                    pass
            # YOLO 라벨 (정규화): class cx cy w h
            lines = []
            for box in boxes:
                if not box or len(box) != 4:
                    continue
                x, y, w, h = box
                cx = (x + w / 2) / W
                cy = (y + h / 2) / H
                nw = w / W
                nh = h / H
                if 0 < nw <= 1 and 0 < nh <= 1:
                    lines.append(f'0 {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}')
            (OUT / 'labels' / sp / f'{stem}.txt').write_text('\n'.join(lines))

    # 5) dataset yaml
    yaml = f"""# AI Hub 경구약제 — YOLO pill 탐지
path: {OUT.resolve()}
train: images/train
val: images/val
nc: 1
names: ['pill']
"""
    (OUT / 'pill.yaml').write_text(yaml)

    print(f'\n{"="*60}')
    print(f'  ✅ 완료! train {len(splits["train"]):,} / val {len(splits["val"]):,}')
    print(f'  데이터셋: {OUT/"pill.yaml"}')
    print(f'{"="*60}')


if __name__ == '__main__':
    main()
