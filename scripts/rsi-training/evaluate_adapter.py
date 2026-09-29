#!/usr/bin/env python3
"""Run the fixed, paired Transformers/PEFT fixture cells in an OpenShell guest."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import pathlib
import tarfile

SEED = 1337
MAX_NEW_TOKENS = 256
MAX_CPU_CHECKPOINT_BYTES = 2 * 1024 * 1024 * 1024
EXPECTED_CELL_IDS = {
    "generalization:positive numeric string",
    "generalization:negative number",
    "generalization:zero string",
}


def sha256(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tree_digest(root: pathlib.Path) -> str:
    entries = []
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        entries.append((path.relative_to(root).as_posix(), sha256(path)))
    return hashlib.sha256(json.dumps(entries, separators=(",", ":")).encode()).hexdigest()


def normalize(value: str) -> str:
    return "\n".join(line.rstrip() for line in value.strip().splitlines())


def extract_adapter_archive(archive_path: pathlib.Path, destination: pathlib.Path) -> pathlib.Path:
    expected_prefix = ".headlesscode-rsi-model-output/adapter/"
    destination.mkdir(parents=True, exist_ok=False)
    observed = set()
    with tarfile.open(fileobj=io.BytesIO(archive_path.read_bytes()), mode="r:") as archive:
        for member in archive.getmembers():
            if member.isdir() and member.name.rstrip("/") == expected_prefix.rstrip("/"):
                continue
            if not member.isfile() or not member.name.startswith(expected_prefix):
                raise ValueError("adapter archive contains an unsafe path or non-regular file")
            name = member.name[len(expected_prefix):]
            if name not in {"adapter_config.json", "adapter_model.safetensors"} or name in observed or member.size > 1024 * 1024 * 1024:
                raise ValueError("adapter archive file set or size is invalid")
            observed.add(name)
            source = archive.extractfile(member)
            if source is None:
                raise ValueError("adapter archive member could not be read")
            (destination / name).write_bytes(source.read())
    if observed != {"adapter_config.json", "adapter_model.safetensors"}:
        raise ValueError("adapter artifact is incomplete")
    return destination


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-model", required=True)
    parser.add_argument("--base-model-id", required=True)
    parser.add_argument("--cells", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--adapter-archive")
    args = parser.parse_args()
    base = pathlib.Path(args.base_model).resolve(strict=True)
    cells_path = pathlib.Path(args.cells).resolve(strict=True)
    output_path = pathlib.Path(args.output).resolve()
    if not str(cells_path).startswith("/workspace/") or not str(output_path).startswith("/workspace/"):
        raise SystemExit("evaluation inputs and output must stay under the OpenShell workspace")
    checkpoint_bytes = sum(path.stat().st_size for path in base.rglob("*") if path.is_file())
    if checkpoint_bytes > MAX_CPU_CHECKPOINT_BYTES:
        raise SystemExit("CPU-only paired evaluation is limited to local checkpoints no larger than 2 GiB")
    cells = [json.loads(line) for line in cells_path.read_text(encoding="utf8").splitlines() if line]
    if {cell.get("id") for cell in cells} != EXPECTED_CELL_IDS or len(cells) != len(EXPECTED_CELL_IDS):
        raise SystemExit("evaluation cell set differs from the fixed generalization fixture set")
    adapter = None
    if args.adapter_archive:
        archive_path = pathlib.Path(args.adapter_archive).resolve(strict=True)
        if not str(archive_path).startswith("/workspace/"):
            raise SystemExit("adapter input must remain under the OpenShell workspace")
        try:
            adapter = extract_adapter_archive(archive_path, pathlib.Path("/workspace/.headlesscode-rsi-model-output/adapter"))
        except (OSError, ValueError, tarfile.TarError) as error:
            raise SystemExit(str(error)) from error
    else:
        adapter = None

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    torch.manual_seed(SEED)
    torch.cuda.manual_seed_all(SEED) if torch.cuda.is_available() else None
    tokenizer = AutoTokenizer.from_pretrained(str(base), local_files_only=True, trust_remote_code=False)
    model = AutoModelForCausalLM.from_pretrained(
        str(base), local_files_only=True, trust_remote_code=False,
        torch_dtype="auto", device_map="auto",
    )
    if adapter:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, str(adapter), local_files_only=True)
    model.eval()
    device = model.get_input_embeddings().weight.device
    results = []
    for cell in cells:
        torch.manual_seed(SEED)
        inputs = tokenizer(cell["prompt"], return_tensors="pt", truncation=True, max_length=512).to(device)
        with torch.inference_mode():
            generated = model.generate(
                **inputs, do_sample=False, max_new_tokens=MAX_NEW_TOKENS,
                pad_token_id=tokenizer.eos_token_id,
            )
        completion = tokenizer.decode(generated[0, inputs["input_ids"].shape[1]:], skip_special_tokens=True)
        exact = normalize(completion) == normalize(cell["completion"])
        results.append({
            "cellId": cell["id"],
            "seed": SEED,
            "exactMatch": exact,
            "outputSha256": hashlib.sha256(completion.encode()).hexdigest(),
            "referenceSha256": hashlib.sha256(cell["completion"].encode()).hexdigest(),
            "preview": completion[:500],
        })
    result = {
        "schemaVersion": 1,
        "status": "completed" if len(results) == len(EXPECTED_CELL_IDS) else "partial",
        "modelKind": "adapter" if adapter else "base",
        "baseModelId": args.base_model_id,
        "seed": SEED,
        "maxNewTokens": MAX_NEW_TOKENS,
        "cellSet": sorted(EXPECTED_CELL_IDS),
        "cellSetSha256": hashlib.sha256("\n".join(sorted(EXPECTED_CELL_IDS)).encode()).hexdigest(),
        "exactMatchRate": sum(1 for item in results if item["exactMatch"]) / len(EXPECTED_CELL_IDS),
        "cellsSha256": sha256(cells_path),
        "baseModelSha256": tree_digest(base),
        "adapterSha256": tree_digest(adapter) if adapter else None,
        "results": results,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, sort_keys=True, indent=2) + "\n", encoding="utf8")
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
