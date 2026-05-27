"""
식약처 이미지 재다운로드 스크립트
— 동시 요청 제한 + 재시도 로직으로 누락된 이미지 복구
— 사용법: cd ml && source venv/bin/activate && python3 redownload_mfds.py
"""
import requests, time, json
from pathlib import Path
from io import BytesIO
from PIL import Image
from tqdm import tqdm

BASE_DIR   = Path(__file__).resolve().parent
DATA_DIR   = BASE_DIR / 'data'
IMAGE_DIR  = DATA_DIR / 'images'
CSV_PATH   = DATA_DIR / 'pills.csv'

API_KEY = '73d5d41569516c5a7259f3928ea2de8af44ded772f2a6cb4d6f5dbe27b0f62cd'
MFDS_PILL_URL = 'https://apis.data.go.kr/1471000/MdcinGrnIdntfcInfoService03/getMdcinGrnIdntfcInfoList03'
MFDS_DRUG_URL = 'https://apis.data.go.kr/1471000/DrbEasyDrugInfoService/getDrbEasyDrugList'

MAX_RETRIES = 3
DELAY = 0.5  # 요청 간 0.5초 대기 (서버 부하 방지)


def safe_dirname(name):
    return ''.join(c for c in name if c not in r'\/:*?"<>|').strip()[:50]


def download_with_retry(url, save_path, retries=MAX_RETRIES):
    if save_path.exists():
        try:
            img = Image.open(str(save_path))
            img.verify()
            return True
        except:
            save_path.unlink()

    for attempt in range(retries):
        try:
            resp = requests.get(url, timeout=30, headers={
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
            })
            if resp.status_code != 200:
                time.sleep(DELAY * (attempt + 1))
                continue

            img = Image.open(BytesIO(resp.content)).convert('RGB')
            if img.width < 50 or img.height < 50:
                return False
            save_path.parent.mkdir(parents=True, exist_ok=True)
            img.save(str(save_path), 'JPEG', quality=90)
            return True
        except Exception:
            time.sleep(DELAY * (attempt + 1))

    return False


def fetch_page(api_url, page_no=1, num_of_rows=100):
    params = {
        'serviceKey': API_KEY,
        'pageNo': page_no,
        'numOfRows': num_of_rows,
        'type': 'json',
    }
    try:
        resp = requests.get(api_url, params=params, timeout=15)
        resp.raise_for_status()
        body = resp.json().get('body', {})
        items = body.get('items', [])
        if isinstance(items, dict):
            items = [items.get('item', {})]
        elif not isinstance(items, list):
            items = []
        return items, int(body.get('totalCount', 0))
    except Exception as e:
        print(f'  오류: {e}')
        return [], 0


def main():
    print('=' * 60)
    print('  식약처 이미지 재다운로드 (순차 + 재시도)')
    print('=' * 60)

    IMAGE_DIR.mkdir(parents=True, exist_ok=True)

    # ── API에서 전체 항목 수집 ──
    all_items = []
    for api_url, label, img_field, name_field, code_field in [
        (MFDS_PILL_URL, '낱알식별', 'ITEM_IMAGE', 'ITEM_NAME', 'ITEM_SEQ'),
        (MFDS_DRUG_URL, '의약품개요', 'itemImage', 'itemName', 'itemSeq'),
    ]:
        _, total = fetch_page(api_url, 1, 1)
        print(f'\n[{label}] 전체: {total:,}개')

        page = 1
        collected = 0
        pbar = tqdm(total=total, desc=f'  {label} 수집')
        while collected < total:
            items, _ = fetch_page(api_url, page, 100)
            if not items:
                break
            for item in items:
                url = (item.get(img_field) or '').strip()
                name = (item.get(name_field) or '').strip()
                code = (item.get(code_field) or str(hash(name))).strip()
                if url and name:
                    all_items.append({
                        'name': name, 'code': code, 'url': url,
                        'shape': item.get('DRUG_SHAPE') or item.get('drugShape') or '',
                        'color_front': item.get('COLOR_CLASS1') or item.get('colorClass1') or '',
                        'color_back': item.get('COLOR_CLASS2') or item.get('colorClass2') or '',
                        'print_front': item.get('PRINT_FRONT') or item.get('printFront') or '',
                        'print_back': item.get('PRINT_BACK') or item.get('printBack') or '',
                    })
            collected += len(items)
            pbar.update(len(items))
            page += 1
            time.sleep(0.3)
        pbar.close()

    # 중복 제거 (약 이름 기준)
    seen = set()
    unique = []
    for item in all_items:
        if item['name'] not in seen:
            seen.add(item['name'])
            unique.append(item)

    print(f'\n중복 제거 후: {len(unique):,}개')

    # ── 누락된 이미지만 다운로드 ──
    missing = []
    for item in unique:
        save_path = IMAGE_DIR / safe_dirname(item['name']) / f'{item["code"]}.jpg'
        if not save_path.exists():
            missing.append((item, save_path))

    existing = len(unique) - len(missing)
    print(f'기존 다운로드 완료: {existing:,}장')
    print(f'누락 (재다운로드 대상): {len(missing):,}장')

    if not missing:
        print('✅ 모든 이미지 다운로드 완료!')
        return

    # 순차 다운로드 (동시 요청 X → 서버 차단 방지)
    success = 0
    fail = 0
    pbar = tqdm(missing, desc='  재다운로드')
    for item, save_path in pbar:
        if download_with_retry(item['url'], save_path):
            success += 1
        else:
            fail += 1
        pbar.set_postfix(ok=success, fail=fail)
        time.sleep(DELAY)
    pbar.close()

    total_ok = existing + success
    print(f'\n✅ 완료! {total_ok:,}장 ({success:,}장 신규 + {existing:,}장 기존)')
    print(f'   실패: {fail:,}장')

    # pills.csv 재생성
    import pandas as pd
    rows = []
    for item in unique:
        save_path = IMAGE_DIR / safe_dirname(item['name']) / f'{item["code"]}.jpg'
        if save_path.exists():
            rows.append({
                'item_code': item['code'],
                'item_name': item['name'],
                'shape': item['shape'],
                'color_front': item['color_front'],
                'color_back': item['color_back'],
                'print_front': item['print_front'],
                'print_back': item['print_back'],
                'image_path': str(save_path),
            })
    df = pd.DataFrame(rows)
    df.to_csv(CSV_PATH, index=False, encoding='utf-8-sig')
    print(f'   pills.csv 갱신: {len(df):,}장')


if __name__ == '__main__':
    main()
