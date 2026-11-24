"""WorldGen NPC voices: Chatterbox voice cloning with one cloned voice per reference clip.

Chatterbox Turbo ("nano") voice cloning, serving several voices
so NPCs do not all sound alike. Listens on loopback only; WorldGen reaches it through SSH or a tunnel.

    GET  /health            -> {"app": "worldgen-voice", "voices": [{"id", "gender", "age"}], ...}
    POST /v1/audio/speech   {"input": "...", "voice": "<voice id>"} -> audio/wav (mono 16-bit PCM)

Voices come from voices/voices.json + voices/<file>.wav (fetch-mistral-samples.mjs creates them).
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import time
import wave
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock

import numpy as np
import torch
from chatterbox.tts_turbo import ChatterboxTurboTTS

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
LOGGER = logging.getLogger("worldgen-voice")
ROOT = Path(__file__).resolve().parent
VOICES_DIR = Path(os.environ.get("WORLDGEN_VOICE_DIR", ROOT / "voices"))
PORT = int(os.environ.get("WORLDGEN_VOICE_PORT", "8794"))
MAX_CHARS = int(os.environ.get("WORLDGEN_VOICE_MAX_CHARS", "1200"))
CACHE_ENTRIES = int(os.environ.get("WORLDGEN_VOICE_CACHE", "128"))
torch.set_num_threads(int(os.environ.get("WORLDGEN_VOICE_THREADS", "4")))

requested_device = os.environ.get("WORLDGEN_VOICE_DEVICE", "auto")
DEVICE = ("cuda" if torch.cuda.is_available() else "cpu") if requested_device == "auto" else requested_device
MODEL = ChatterboxTurboTTS.from_pretrained(device=DEVICE, nano=True)

# One conditioning set per voice, prepared once. Swapping MODEL.conds is how Chatterbox switches
# speaker without re-reading the clip; if a build lacks .conds we pass the clip path per request.
VOICES: dict[str, dict] = {}
manifest = json.loads((VOICES_DIR / "voices.json").read_text(encoding="utf-8"))["voices"]
for entry in manifest:
    clip = VOICES_DIR / entry["file"]
    if not clip.is_file():
        LOGGER.warning("voice %s: missing %s, skipped", entry["id"], clip.name)
        continue
    MODEL.prepare_conditionals(str(clip))
    VOICES[entry["id"]] = {
        "gender": entry.get("gender") or "neutral",
        "age": entry.get("age"),
        "clip": str(clip),
        "conds": getattr(MODEL, "conds", None),
    }
    LOGGER.info("voice %s ready (%s, %s)", entry["id"], entry.get("gender"), entry.get("age"))
if not VOICES:
    raise SystemExit(f"No voices found in {VOICES_DIR}")

LOCK = Lock()
CACHE: "OrderedDict[str, bytes]" = OrderedDict()
LAST_SECONDS = 0.0


def synthesize(text: str, voice_id: str) -> bytes:
    """Mono 16-bit WAV for text in the given voice; repeated lines come from a small LRU cache."""
    global LAST_SECONDS
    key = hashlib.sha256(f"{voice_id}\0{text}".encode()).hexdigest()
    with LOCK:
        if key in CACHE:
            CACHE.move_to_end(key)
            return CACHE[key]
        voice = VOICES[voice_id]
        started = time.monotonic()
        with torch.inference_mode():
            if voice["conds"] is not None:
                MODEL.conds = voice["conds"]
                audio = MODEL.generate(text)
            else:
                audio = MODEL.generate(text, audio_prompt_path=voice["clip"])
        samples = audio.detach().cpu().numpy().reshape(-1)
        LAST_SECONDS = round(time.monotonic() - started, 2)
        pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
        out = io.BytesIO()
        with wave.open(out, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(MODEL.sr)
            wav.writeframes(pcm)
        data = out.getvalue()
        CACHE[key] = data
        while len(CACHE) > CACHE_ENTRIES:
            CACHE.popitem(last=False)
        LOGGER.info("%s: %d chars in %.2fs", voice_id, len(text), LAST_SECONDS)
        return data


class Handler(BaseHTTPRequestHandler):
    def send(self, status: int, data: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def json(self, status: int, data: dict) -> None:
        self.send(status, json.dumps(data).encode(), "application/json")

    def do_GET(self) -> None:
        if self.path != "/health":
            return self.json(404, {"error": "Not found"})
        self.json(200, {
            "app": "worldgen-voice", "model": "chatterbox-turbo-nano", "device": DEVICE,
            "sample_rate": MODEL.sr, "last_generation_seconds": LAST_SECONDS,
            "voices": [{"id": vid, "gender": v["gender"], "age": v["age"]} for vid, v in VOICES.items()],
        })

    def do_POST(self) -> None:
        if self.path != "/v1/audio/speech":
            return self.json(404, {"error": "Not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 20000:
                raise ValueError("Invalid speech request size")
            data = json.loads(self.rfile.read(length))
            text = str(data.get("input") or "").strip()
            if not text or len(text) > MAX_CHARS:
                raise ValueError(f"Speech text must contain 1 to {MAX_CHARS} characters")
            voice_id = str(data.get("voice") or "")
            if voice_id not in VOICES:
                raise ValueError(f"Unknown voice {voice_id!r}")
            self.send(200, synthesize(text, voice_id), "audio/wav")
        except ValueError as error:
            self.json(400, {"error": str(error)})
        except Exception as error:  # model failures: report, keep serving
            LOGGER.exception("speech generation failed")
            self.json(503, {"error": "Voice generation failed: " + type(error).__name__})

    def log_message(self, format: str, *args: object) -> None:
        pass


if __name__ == "__main__":
    LOGGER.info("WorldGen voices ready on 127.0.0.1:%d (%s, %d voices)", PORT, DEVICE, len(VOICES))
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
