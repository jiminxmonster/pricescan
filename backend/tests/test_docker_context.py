from pathlib import Path


def test_backend_docker_context_excludes_runtime_data() -> None:
    dockerignore = Path(__file__).resolve().parents[1] / ".dockerignore"
    patterns = {
        line.strip()
        for line in dockerignore.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }

    assert "data/" in patterns, (
        "backend/data contains databases and browser profiles and must not be "
        "copied into the backend Docker build context"
    )
