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
        project=str(ML / 'output'),
        name='yolo_pill',
        exist_ok=True,
        verbose=True,
    )
    print('✅ YOLO 학습 완료 → output/yolo_pill/weights/best.pt')

if __name__ == '__main__':
    main()
