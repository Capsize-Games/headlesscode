#!/usr/bin/env python3
"""Fixed, offline QLoRA trainer. It accepts only the supervisor's verified fixture dataset."""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys
import traceback

MAX_STEPS = 8
SEED = 1337
MAX_DATASET_BYTES = 256 * 1024
MAX_ROWS = 8


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def tree_digest(root: pathlib.Path) -> str:
    entries = []
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        entries.append((path.relative_to(root).as_posix(), sha256(path)))
    return hashlib.sha256(json.dumps(entries, separators=(",", ":")).encode()).hexdigest()


def write_result(path: pathlib.Path, value: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n", encoding="utf8")
    temporary.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-model", required=True)
    parser.add_argument("--base-model-id", required=True)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    base = pathlib.Path(args.base_model).resolve(strict=True)
    dataset = pathlib.Path(args.dataset).resolve(strict=True)
    manifest_path = pathlib.Path(args.manifest).resolve(strict=True)
    output = pathlib.Path(args.output).resolve()
    result_path = output / "training-result.json"
    result = {"schemaVersion": 1, "status": "failed", "seed": SEED, "maxSteps": MAX_STEPS, "baseModelId": args.base_model_id}
    try:
        if not base.is_dir() or not (base / "config.json").is_file():
            raise ValueError("base model must be a local Hugging Face checkpoint directory")
        if not str(dataset).startswith("/workspace/") or not str(manifest_path).startswith("/workspace/") or not str(output).startswith("/workspace/"):
            raise ValueError("training inputs and output must stay under the OpenShell workspace")
        if output.exists() and any(output.iterdir()):
            raise ValueError("training output directory must be new and empty")
        output.mkdir(parents=True, exist_ok=True)
        if dataset.stat().st_size < 1 or dataset.stat().st_size > MAX_DATASET_BYTES:
            raise ValueError("verified dataset size is outside the 1-256 KiB bound")
        manifest = json.loads(manifest_path.read_text(encoding="utf8"))
        if manifest.get("schemaVersion") != 1 or manifest.get("backend") != "transformers-peft-qlora-v1":
            raise ValueError("unsupported verified training manifest")
        if manifest.get("seed") != SEED or manifest.get("maxSteps") != MAX_STEPS or manifest.get("rowCount") != 3:
            raise ValueError("training manifest bounds do not match the fixed QLoRA policy")
        dataset_hash = sha256(dataset)
        if dataset_hash != manifest.get("datasetSha256"):
            raise ValueError("training dataset digest differs from the verified manifest")
        rows = [json.loads(line) for line in dataset.read_text(encoding="utf8").splitlines() if line]
        if len(rows) != 3 or len(rows) > MAX_ROWS or {row.get("id") for row in rows} != set(manifest["trainingFixtureIds"]):
            raise ValueError("training data rows do not match the registered fixture set")
        if any(not isinstance(row.get("prompt"), str) or not isinstance(row.get("completion"), str) or not row["completion"].startswith("export function solve") for row in rows):
            raise ValueError("training row has an invalid prompt or fixture reference completion")

        import torch
        from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

        if not torch.cuda.is_available():
            raise RuntimeError("QLoRA training requires an OpenShell guest with an NVIDIA GPU")
        torch.manual_seed(SEED)
        torch.cuda.manual_seed_all(SEED)
        tokenizer = AutoTokenizer.from_pretrained(str(base), local_files_only=True, trust_remote_code=False)
        if tokenizer.pad_token_id is None:
            tokenizer.pad_token = tokenizer.eos_token
        compute_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        quantization = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=compute_dtype,
        )
        model = AutoModelForCausalLM.from_pretrained(
            str(base), local_files_only=True, trust_remote_code=False,
            quantization_config=quantization, device_map="auto",
        )
        model.config.use_cache = False
        model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
        names = {name.rsplit(".", 1)[-1] for name, _ in model.named_modules()}
        targets = [name for name in ("q_proj", "k_proj", "v_proj", "o_proj") if name in names]
        if not targets:
            raise RuntimeError("base model has no supported q_proj/k_proj/v_proj/o_proj modules")
        model = get_peft_model(model, LoraConfig(
            r=8, lora_alpha=16, lora_dropout=0.05, bias="none",
            task_type="CAUSAL_LM", target_modules=targets,
        ))
        model.train()
        encoded = []
        for row in rows:
            prefix = "### Task\n" + row["prompt"] + "\n\n### Reference solution\n"
            prefix_ids = tokenizer(prefix, add_special_tokens=True)["input_ids"]
            completion_ids = tokenizer(row["completion"] + tokenizer.eos_token, add_special_tokens=False)["input_ids"]
            input_ids = prefix_ids + completion_ids
            labels = [-100] * len(prefix_ids) + completion_ids
            encoded.append((input_ids, labels))
        optimizer = torch.optim.AdamW((param for param in model.parameters() if param.requires_grad), lr=2e-4)
        steps = 0
        for step in range(MAX_STEPS):
            input_ids, labels = encoded[step % len(encoded)]
            device = model.get_input_embeddings().weight.device
            tokens = torch.tensor([input_ids], dtype=torch.long, device=device)
            targets_tensor = torch.tensor([labels], dtype=torch.long, device=device)
            loss = model(input_ids=tokens, labels=targets_tensor).loss
            loss.backward()
            optimizer.step()
            optimizer.zero_grad(set_to_none=True)
            steps += 1
            if not torch.isfinite(loss).item():
                raise RuntimeError("training loss became non-finite")
        adapter_dir = output / "adapter"
        model.save_pretrained(adapter_dir, safe_serialization=True)
        readme = adapter_dir / "README.md"
        if readme.is_file():
            readme.unlink()
        names = sorted(path.name for path in adapter_dir.iterdir() if path.is_file())
        if names != ["adapter_config.json", "adapter_model.safetensors"]:
            raise RuntimeError("training ended without exactly the fixed PEFT adapter file set")
        result.update({
            "status": "completed",
            "stepsCompleted": steps,
            "datasetSha256": dataset_hash,
            "manifestSha256": sha256(manifest_path),
            "baseModelSha256": tree_digest(base),
            "adapterSha256": tree_digest(adapter_dir),
            "adapterBytes": sum(path.stat().st_size for path in adapter_dir.rglob("*") if path.is_file()),
            "targetModules": targets,
        })
        write_result(result_path, result)
        print(json.dumps(result, sort_keys=True))
        return 0
    except BaseException as error:
        result["status"] = "partial" if isinstance(error, KeyboardInterrupt) else "failed"
        result["error"] = str(error)[:1500]
        result["traceback"] = traceback.format_exc(limit=6)[-3000:]
        try:
            write_result(result_path, result)
        except Exception:
            pass
        print(json.dumps(result, sort_keys=True), file=sys.stderr)
        return 130 if isinstance(error, KeyboardInterrupt) else 2


if __name__ == "__main__":
    raise SystemExit(main())
