"""
Persistent cross-session speaker identity database.
Stores speaker embeddings as float lists in a JSON file.
Identification uses cosine similarity against all stored embeddings.
"""
import json
import os
import uuid
import threading
import numpy as np
from typing import Optional, Tuple, List, Dict, Any
import structlog

log = structlog.get_logger(__name__)

DEFAULT_THRESHOLD = 0.75


class SpeakerDatabase:
    def __init__(self, path: str = "speakers_db.json", threshold: float = DEFAULT_THRESHOLD):
        self._path = path
        self._threshold = threshold
        self._lock = threading.Lock()
        self._data: Dict[str, Any] = {"version": 1, "persons": {}}
        self._load()

    def _load(self):
        if not os.path.exists(self._path):
            return
        try:
            with open(self._path, "r", encoding="utf-8") as f:
                self._data = json.load(f)
            count = len(self._data.get("persons", {}))
            log.info("speaker_db_loaded", persons=count, path=self._path)
        except Exception as e:
            log.error("speaker_db_load_failed", error=str(e))

    def _save(self):
        try:
            with open(self._path, "w", encoding="utf-8") as f:
                json.dump(self._data, f)
        except Exception as e:
            log.error("speaker_db_save_failed", error=str(e))

    def identify(self, embedding: np.ndarray) -> Tuple[Optional[str], Optional[str], float]:
        """
        Find the best matching person for the given embedding.
        Returns (person_id, person_name, confidence) or (None, None, best_score).
        """
        with self._lock:
            persons = dict(self._data.get("persons", {}))

        if not persons:
            return None, None, 0.0

        emb = embedding.astype(np.float32)
        norm = np.linalg.norm(emb)
        if norm < 1e-9:
            return None, None, 0.0
        emb = emb / norm

        best_id = None
        best_name = None
        best_score = 0.0

        for person_id, person in persons.items():
            embeddings = person.get("embeddings", [])
            if not embeddings:
                continue
            for stored in embeddings:
                stored_arr = np.array(stored, dtype=np.float32)
                stored_norm = np.linalg.norm(stored_arr)
                if stored_norm < 1e-9:
                    continue
                stored_arr = stored_arr / stored_norm
                score = float(np.dot(emb, stored_arr))
                if score > best_score:
                    best_score = score
                    best_id = person_id
                    best_name = person["name"]

        if best_score >= self._threshold:
            return best_id, best_name, best_score
        return None, None, best_score

    def list_persons(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [
                {
                    "id": pid,
                    "name": p["name"],
                    "embedding_count": len(p.get("embeddings", [])),
                }
                for pid, p in self._data.get("persons", {}).items()
            ]

    def add_person(self, name: str, embeddings: List[List[float]], person_id: Optional[str] = None) -> str:
        """Create a new person or add embeddings to an existing one. Returns person_id."""
        with self._lock:
            if person_id and person_id in self._data["persons"]:
                self._data["persons"][person_id]["embeddings"].extend(embeddings)
                self._save()
                return person_id
            pid = person_id or str(uuid.uuid4())
            self._data["persons"][pid] = {"name": name, "embeddings": embeddings}
            self._save()
            return pid

    def delete_person(self, person_id: str) -> bool:
        with self._lock:
            if person_id not in self._data.get("persons", {}):
                return False
            del self._data["persons"][person_id]
            self._save()
            return True

    def rename_person(self, person_id: str, name: str) -> bool:
        with self._lock:
            if person_id not in self._data.get("persons", {}):
                return False
            self._data["persons"][person_id]["name"] = name
            self._save()
            return True
