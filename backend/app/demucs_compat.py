from __future__ import annotations

import wave
from pathlib import Path

from demucs import audio as demucs_audio
from demucs import separate as demucs_separate


_original_save_audio = demucs_audio.save_audio


def _write_pcm16_wav(wav, path: Path, samplerate: int) -> None:
    """Write a channels-first torch tensor as deterministic 16-bit PCM WAV.

    Demucs 4.0.1 delegates WAV output to torchaudio.save(). The CPU-only
    TorchAudio wheel used on Railway can decode through FFmpeg while exposing
    no writable audio backend, so inference succeeds and then fails only while
    saving the stems. Using the standard-library wave writer removes that
    optional backend dependency without changing Demucs inference.
    """
    if wav.ndim == 1:
        wav = wav.unsqueeze(0)
    if wav.ndim != 2:
        raise RuntimeError(f"Unsupported Demucs waveform shape: {tuple(wav.shape)}")

    channels = int(wav.shape[0])
    pcm = (wav.clamp(-1, 1) * 32767.0).round().to(dtype=wav.new_empty((), dtype=None).short().dtype)
    interleaved = pcm.transpose(0, 1).contiguous().cpu().numpy().astype("<i2", copy=False)

    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(channels)
        output.setsampwidth(2)
        output.setframerate(int(samplerate))
        output.writeframes(interleaved.tobytes())


def save_audio_compat(
    wav,
    path,
    samplerate: int,
    bitrate: int = 320,
    clip: str = "rescale",
    bits_per_sample: int = 16,
    as_float: bool = False,
    preset: int = 2,
) -> None:
    target = Path(path)
    if target.suffix.lower() != ".wav":
        _original_save_audio(
            wav,
            target,
            samplerate=samplerate,
            bitrate=bitrate,
            clip=clip,
            bits_per_sample=bits_per_sample,
            as_float=as_float,
            preset=preset,
        )
        return

    if as_float or bits_per_sample != 16:
        raise RuntimeError(
            "MAGHRABI Demucs compatibility writer currently supports the production 16-bit WAV path only."
        )

    prepared = demucs_audio.prevent_clip(wav, mode=clip)
    _write_pcm16_wav(prepared, target, samplerate)


def main() -> None:
    demucs_audio.save_audio = save_audio_compat
    demucs_separate.save_audio = save_audio_compat
    demucs_separate.main()


if __name__ == "__main__":
    main()
