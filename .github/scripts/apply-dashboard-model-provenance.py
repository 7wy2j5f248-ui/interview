from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace(path, old, new):
    file = ROOT / path
    text = file.read_text()
    if old not in text:
        raise RuntimeError(f"Expected text not found in {path}: {old[:100]!r}")
    file.write_text(text.replace(old, new, 1))

# Statistics API: expose the frozen interview model and protocol metadata