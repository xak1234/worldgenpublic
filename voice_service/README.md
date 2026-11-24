# WorldGen NPC voices (self-hosted Chatterbox)

Gives each NPC a cloned voice without a paid speech API. It runs
[Chatterbox](https://github.com/resemble-ai/chatterbox) (Turbo, "nano" size) on a machine you
control and serves several cloned voices, picked per NPC by gender and age. It listens on loopback
only (`127.0.0.1:8794`); WorldGen reaches it over SSH or through a tunnel.

The voices come from reference clips listed in `voices/voices.json` (`id`, `file`, `gender`, `age`).
`fetch-mistral-samples.mjs` fills that folder from voices tagged `worldgen` on a Mistral account (the
reference recordings behind WorldGen's Voxtral voices: public-domain LibriVox readings). You can also
use your own clean 10-20 second WAV clips, with a matching manifest entry for each. The `.wav` files
are not committed.

## Install on the voice host (Linux, Python 3.12, systemd user services)

    # on the voice host
    mkdir -p ~/apps/worldgen-voice ~/.config/systemd/user
    cd ~/apps/worldgen-voice
    python3.12 -m venv .venv
    .venv/bin/pip install -r requirements.txt

    # from the WorldGen folder (voice-host = an SSH alias for that machine)
    node voice_service/fetch-mistral-samples.mjs        # or put your own clips in voice_service/voices/
    scp voice_service/server.py voice_service/requirements.txt voice-host:apps/worldgen-voice/
    scp -r voice_service/voices voice-host:apps/worldgen-voice/
    scp voice_service/worldgen-voice.service voice-host:.config/systemd/user/
    ssh voice-host "systemctl --user daemon-reload && systemctl --user enable --now worldgen-voice"
    ssh voice-host "curl -s http://127.0.0.1:8794/health"

The first start downloads the model weights, then prepares every voice (around 15 seconds). Health
lists the loaded voices. Logs: `journalctl --user -u worldgen-voice -n 30`. To keep it running without
a login session: `loginctl enable-linger $USER`.

If the host already has a Python environment with Chatterbox installed, point `ExecStart` in
`worldgen-voice.service` at that environment's `python` instead of creating a new one.

## Point WorldGen at it (.env)

    VOICE_TTS_BACKEND=chatterbox
    CHATTERBOX_SSH_HOST=voice-host

With `CHATTERBOX_SSH_HOST` set, WorldGen runs `ssh <host> curl http://127.0.0.1:8794/...` for each
request: no network listener on the voice host and no tunnel to keep open. This needs key-based SSH
(BatchMode). Without it, WorldGen calls `CHATTERBOX_TTS_URL` directly (default
`http://127.0.0.1:8794`), for example through `ssh -N -L 8794:127.0.0.1:8794 voice-host`.

## Speed

On a modern 32-core CPU with 8 threads (`WORLDGEN_VOICE_THREADS`), a typical line of NPC dialogue takes
about 4 seconds, faster than the audio it produces. A 128-entry cache replays repeated lines
instantly. The browser waits up to 60 seconds, then falls back to the browser's built-in voice for that
line. `WORLDGEN_VOICE_DEVICE=cuda` uses a GPU when the environment has a GPU build of PyTorch.
