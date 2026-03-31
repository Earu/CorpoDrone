"""
huggingface_hub 0.x (required for pyannote 3.x + hf_hub_download(use_auth_token=...))
does not expose is_offline_mode; newer transitive deps import it from hub 1.x.

Patch the module dict before those imports — same semantics as hub 1.x constants.
"""
import os


def _env_truthy(name: str) -> bool:
    v = os.environ.get(name)
    if v is None:
        return False
    return v.upper() in ("1", "ON", "YES", "TRUE")


def _apply() -> None:
    import huggingface_hub

    if hasattr(huggingface_hub, "is_offline_mode"):
        return

    def is_offline_mode() -> bool:
        return _env_truthy("HF_HUB_OFFLINE") or _env_truthy("TRANSFORMERS_OFFLINE")

    huggingface_hub.__dict__["is_offline_mode"] = is_offline_mode


_apply()
