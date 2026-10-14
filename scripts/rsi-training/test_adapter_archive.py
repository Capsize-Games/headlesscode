from __future__ import annotations

import importlib.util
import io
import pathlib
import tarfile
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name("evaluate_adapter.py")
SPEC = importlib.util.spec_from_file_location("rsi_evaluate_adapter", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def tar_bytes(entries: list[tuple[str, bytes, tarfile.TarInfo | None]]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:") as archive:
        for name, content, custom_info in entries:
            info = custom_info or tarfile.TarInfo(name)
            info.name = name
            if info.isfile():
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
            else:
                archive.addfile(info)
    return buffer.getvalue()


class AdapterArchiveTest(unittest.TestCase):
    def test_extracts_only_the_two_expected_regular_files(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            archive = pathlib.Path(root) / "adapter.tar"
            archive.write_bytes(tar_bytes([
                (".headlesscode-rsi-model-output/adapter/adapter_config.json", b"{}", None),
                (".headlesscode-rsi-model-output/adapter/adapter_model.safetensors", b"weights", None),
            ]))
            destination = pathlib.Path(root) / "out"
            MODULE.extract_adapter_archive(archive, destination)
            self.assertEqual((destination / "adapter_config.json").read_bytes(), b"{}")
            self.assertEqual((destination / "adapter_model.safetensors").read_bytes(), b"weights")

    def test_skips_leading_directory_entries(self) -> None:
        parent = tarfile.TarInfo(".headlesscode-rsi-model-output/")
        parent.type = tarfile.DIRTYPE
        nested = tarfile.TarInfo(".headlesscode-rsi-model-output/adapter/")
        nested.type = tarfile.DIRTYPE
        with tempfile.TemporaryDirectory() as root:
            archive = pathlib.Path(root) / "adapter.tar"
            archive.write_bytes(tar_bytes([
                (".headlesscode-rsi-model-output/", b"", parent),
                (".headlesscode-rsi-model-output/adapter/", b"", nested),
                (".headlesscode-rsi-model-output/adapter/adapter_config.json", b"{}", None),
                (".headlesscode-rsi-model-output/adapter/adapter_model.safetensors", b"weights", None),
            ]))
            destination = pathlib.Path(root) / "out"
            MODULE.extract_adapter_archive(archive, destination)
            self.assertEqual((destination / "adapter_config.json").read_bytes(), b"{}")

    def test_rejects_path_escape_symlinks_and_extra_files(self) -> None:
        cases = [
            [("../outside", b"x", None)],
            [(".headlesscode-rsi-model-output/adapter/link", b"", tarfile.TarInfo("ignored"))],
            [(".headlesscode-rsi-model-output/adapter/extra.bin", b"x", None)],
        ]
        cases[1][0][2].type = tarfile.SYMTYPE  # type: ignore[union-attr]
        cases[1][0][2].linkname = "/etc/passwd"  # type: ignore[union-attr]
        for entries in cases:
            with self.subTest(entries=entries), tempfile.TemporaryDirectory() as root:
                archive = pathlib.Path(root) / "adapter.tar"
                archive.write_bytes(tar_bytes(entries))
                with self.assertRaises(ValueError):
                    MODULE.extract_adapter_archive(archive, pathlib.Path(root) / "out")


if __name__ == "__main__":
    unittest.main()
