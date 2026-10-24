"""Inference adapter only: reuse the existing local PyTorch Qwen weights."""
import contextlib
import json
import sys
from pathlib import Path

request = json.load(sys.stdin)
with contextlib.redirect_stdout(sys.stderr):
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer(
        str(Path(request["model_path"]).expanduser()),
        device="cpu",
        local_files_only=True,
    )
    vectors = model.encode(
        request["texts"], batch_size=1,
        normalize_embeddings=True, show_progress_bar=True,
    )
json.dump(vectors.tolist(), sys.stdout)
