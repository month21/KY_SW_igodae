"""
YOLOv8n 약 탐지 학습 (1클래스 'pill')
- 데이터: data/yolo/pill.yaml (AI Hub 박스 변환본)
- 목적: 사진에서 약 위치를 박스로 탐지 → SAM 대체 → 각 박스 ArcFace 인식
- 결과: output/yolo_pill/weights/best.pt
"""
from pathlib import Path
from ultralytics import YOLO

ML = Path(__file__).parent

def main():
    model = YOLO('yolov8n.pt')   # nano 사전학습 (빠름)
    model.train(
        data=str(ML / 'data' / 'yolo' / 'pill.yaml'),
        epochs=25,
        imgsz=512,            # 640→512: 속도↑ (약 탐지엔 충분)
        batch=24,
        device='mps',
        patience=6,           # 6에폭 개선 없으면 조기 종료
        workers=4,
        # ── 약 탐지 특화 증강: 약은 방향이 없음 → 회전·상하/좌우 반전 강화 ──
        degrees=180,          # 모든 회전 각도 (약은 어느 방향이든 같음)
        flipud=0.5,           # 상하 반전 (기본 0 → 0.5)
        fliplr=0.5,           # 좌우 반전
        hsv_v=0.5,            # 밝기 변화 강화 (조명 다양성 → 실사진 robust)
        scale=0.5,            # 크기 변화 (가까이/멀리)
        project=str(ML / 'output'),
        name='yolo_pill',
        exist_ok=True,
        verbose=True,
    )
    print('✅ YOLO 학습 완료 → output/yolo_pill/weights/best.pt')

if __name__ == '__main__':
    main()
