#!/usr/bin/env python3
"""Run the Hugging Face Unlimited-OCR-MLX engine over rendered page images."""
import argparse
import importlib.util
import sys
from pathlib import Path


def install_safetensors_torch_compat() -> None:
    # The published MLX loader imports safetensors.torch even though it only
    # needs CPU tensors before converting them to MLX arrays.
    import types
    from safetensors import safe_open
    import numpy as np

    class TensorCompat:
        def __init__(self, value):
            self.value = value

        def float(self):
            return self

        def numpy(self):
            return self.value

    def load_file(filename, device='cpu'):
        with safe_open(filename, framework='numpy', device=device) as handle:
            weights = {}
            for source_key in handle.keys():
                if source_key == 'vision_model.embeddings.position_ids':
                    continue
                key = source_key
                if key.startswith('sam_model.neck.'):
                    key = key.replace('sam_model.neck.', 'sam_model.neck.layers.', 1)
                value = handle.get_tensor(source_key)
                if source_key == 'sam_model.patch_embed.proj.weight' or source_key in {
                    'sam_model.neck.0.weight',
                    'sam_model.neck.2.weight',
                }:
                    value = np.transpose(value, (0, 2, 3, 1))
                if source_key.endswith(('.rel_pos_h', '.rel_pos_w')) and value.shape[0] == 27:
                    value = np.pad(value, ((50, 50), (0, 0)))
                weights[key] = TensorCompat(value)
            import mlx.core as mx
            weights['vision_model.embeddings.position_ids'] = TensorCompat(
                mx.arange(257, dtype=mx.int32)[None, :]
            )
            return weights

    torch_module = types.ModuleType('safetensors.torch')
    torch_module.load_file = load_file
    torch_module.storage_ptr = lambda tensor: 0
    torch_module.storage_size = lambda tensor: 0
    import safetensors
    safetensors.torch = torch_module
    sys.modules['safetensors.torch'] = torch_module


def load_engine_class(model_dir: str):
    package_dir = Path(model_dir)
    package_name = 'unlimited_ocr_mlx'
    model_path = package_dir / 'model.py'
    model_source = model_path.read_text(encoding='utf-8')
    model_source = model_source.replace(
        "inputs_embeds = inputs_embeds.at[idx].set(\n                        mx.where(mask, img_feats, inputs_embeds[idx])\n                    )",
        "row = inputs_embeds[idx]\n                    image_start = 1\n                    image_end = image_start + img_feats.shape[0]\n                    updated = mx.where(mask[image_start:image_end], img_feats, row[image_start:image_end])\n                    row = mx.concatenate((row[:image_start], updated, row[image_end:]), axis=0)\n                    inputs_embeds = mx.concatenate((inputs_embeds[:idx], row[None, ...], inputs_embeds[idx + 1:]), axis=0)"
    )
    model_path.write_text(model_source, encoding='utf-8')
    spec = importlib.util.spec_from_file_location(
        package_name,
        package_dir / '__init__.py',
        submodule_search_locations=[str(package_dir)],
    )
    if spec is None or spec.loader is None:
        raise ImportError(f'Unable to load MLX package from {package_dir}')
    package = importlib.util.module_from_spec(spec)
    sys.modules[package_name] = package
    spec.loader.exec_module(package)
    import unlimited_ocr_mlx.inference as inference_module
    from unlimited_ocr_mlx.inference import UnlimitedOCRInference
    from unlimited_ocr_mlx.model import UnlimitedOCRModel

    original_load_weights = UnlimitedOCRModel.load_weights

    def load_weights_compat(model, weights):
        adjusted = []
        for key, value in weights:
            expected = model.parameters()
            target = expected
            for part in key.split('.'):
                if isinstance(target, dict) and part in target:
                    target = target[part]
                else:
                    target = None
                    break
            array = value.value if hasattr(value, 'value') else value
            if target is not None and hasattr(target, 'shape') and hasattr(array, 'shape') and target.shape != array.shape:
                if key.endswith(('.rel_pos_h', '.rel_pos_w')) and target.ndim == 2 and target.shape[1] == array.shape[1]:
                    import mlx.core as mx
                    padded = mx.zeros(target.shape, dtype=mx.float32)
                    length = min(target.shape[0], array.shape[0])
                    padded[:length] = mx.array(array[:length])
                    array = padded
                elif getattr(array, 'ndim', 0) == 4 and target.shape == (array.shape[0], array.shape[2], array.shape[3], array.shape[1]):
                    array = array.transpose(0, 2, 3, 1)
            adjusted.append((key, array))
        return original_load_weights(model, adjusted)

    UnlimitedOCRModel.load_weights = load_weights_compat

    from transformers import AutoTokenizer
    def load_tokenizer(model_dir):
        return AutoTokenizer.from_pretrained(model_dir, use_fast=False, trust_remote_code=False)
    inference_module.load_tokenizer = load_tokenizer
    return UnlimitedOCRInference


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir', required=True)
    parser.add_argument('--image-dir', required=True)
    parser.add_argument('--output-dir', required=True)
    args = parser.parse_args()

    install_safetensors_torch_compat()
    inference_path = Path(args.model_dir) / 'inference.py'
    inference_source = inference_path.read_text(encoding='utf-8')
    inference_source = inference_source.replace('mx.array([seq_mask], dtype=bool)', 'mx.array(seq_mask.tolist(), dtype=mx.bool_)')
    inference_source = inference_source.replace('mx.array([seq_mask], dtype=mx.bool_)', 'mx.array([seq_mask.tolist()], dtype=mx.bool_)')
    inference_source = inference_source.replace('mx.array(seq_mask.tolist(), dtype=mx.bool_)', 'mx.array([seq_mask.tolist()], dtype=mx.bool_)')
    inference_source = inference_source.replace('n_image_tokens = 272  # 256 + 16 newlines + separator', 'n_image_tokens = 273  # projector output includes the image separator token')
    inference_source = inference_source.replace('np.zeros(len(input_ids) + total_image_feats, dtype=mx.bool_)', 'np.zeros(len(input_ids) + total_image_feats, dtype=bool)')
    inference_source = inference_source.replace(
        "inputs_embeds = inputs_embeds.at[idx].set(\n                        mx.where(mask, img_feats, inputs_embeds[idx])\n                    )",
        "row = inputs_embeds[idx]\n                    prefix = row[:mask.shape[0]]\n                    updated = mx.where(mask, img_feats, prefix)\n                    row = mx.concatenate((updated, row[mask.shape[0]:]), axis=0)\n                    inputs_embeds = mx.concatenate((inputs_embeds[:idx], row[None, ...], inputs_embeds[idx + 1:]), axis=0)"
    )
    inference_path.write_text(inference_source, encoding='utf-8')
    UnlimitedOCRInference = load_engine_class(args.model_dir)
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
            crop_mode=False,
        )
        page_number = image_path.stem.removeprefix('page_')
        (output_dir / f'page-{page_number}.md').write_text(text, encoding='utf-8')


if __name__ == '__main__':
    main()
