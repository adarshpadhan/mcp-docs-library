#!/usr/bin/env python3
"""Run the Hugging Face Unlimited-OCR-MLX engine over rendered page images."""
import argparse
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir', required=True)
    parser.add_argument('--image-dir', required=True)
    parser.add_argument('--output-dir', required=True)
    args = parser.parse_args()

    sys.path.insert(0, args.model_dir)
    from unlimited_ocr_mlx.inference import UnlimitedOCRInference

    engine = UnlimitedOCRInference(args.model_dir).load()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    for image_path in sorted(Path(args.image_dir).glob('page_*.png')):
        text = engine.infer_single(
            image_path=str(image_path),
            prompt='document parsing.',
            output_dir=None,
            max_length=32768,
            temperature=0.0,
            crop_mode=True,
        )
        page_number = image_path.stem.removeprefix('page_')
        (output_dir / f'page-{page_number}.md').write_text(text, encoding='utf-8')


if __name__ == '__main__':
    main()
