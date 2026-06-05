"""TTS 语音生成服务：将文本转为语音"""
from __future__ import annotations

import hashlib
import struct
import io
import base64
from typing import Optional

import httpx

from config import get_settings


async def generate_tts(text: str, voice_id: str = "default") -> Optional[bytes]:
    """
    将文本转为语音音频。
    若 TTS API 可用则调用，否则返回 mock 音频（静音 WAV）。
    返回 WAV 格式的 bytes。
    """
    settings = get_settings()

    # 尝试调用 MiniMax TTS API
    minimax_key = getattr(settings, "minimax_api_key", "")
    if minimax_key:
        try:
            return await _call_minimax_tts(text, minimax_key)
        except Exception:
            pass

    # Mock 模式：生成静音 WAV（根据文本长度计算时长）
    return _generate_mock_wav(text)


async def _call_minimax_tts(text: str, api_key: str) -> bytes:
    """调用 MiniMax TTS API"""
    url = "https://api.minimax.chat/v1/t2a_v2"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    body = {
        "model": "speech-01-turbo",
        "text": text,
        "voice_setting": {
            "voice_id": "female-shaonv",
            "speed": 0.85,
            "vol": 0.8,
            "pitch": 0,
        },
        "audio_setting": {
            "sample_rate": 24000,
            "bitrate": 128000,
            "format": "wav",
        },
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, headers=headers, json=body)
        data = resp.json()

        if "data" in data and "audio" in data["data"]:
            audio_hex = data["data"]["audio"]
            return bytes.fromhex(audio_hex)

    raise Exception("MiniMax TTS failed")


def _generate_mock_wav(text: str) -> bytes:
    """
    Mock 模式：生成静音 WAV 文件。
    根据文本长度估算时长（约 4 字/秒），生成对应长度的静音。
    """
    # 估算时长：中文约 4 字/秒，最少 1 秒，最多 60 秒
    char_count = len(text)
    duration_sec = max(1.0, min(60.0, char_count / 4.0))

    sample_rate = 16000
    num_samples = int(sample_rate * duration_sec)
    bits_per_sample = 16
    num_channels = 1
    byte_rate = sample_rate * num_channels * bits_per_sample // 8
    block_align = num_channels * bits_per_sample // 8
    data_size = num_samples * block_align

    # WAV header
    wav = io.BytesIO()
    wav.write(b"RIFF")
    wav.write(struct.pack("<I", 36 + data_size))
    wav.write(b"WAVE")
    wav.write(b"fmt ")
    wav.write(struct.pack("<I", 16))  # chunk size
    wav.write(struct.pack("<HHIIHH", 1, num_channels, sample_rate, byte_rate, block_align, bits_per_sample))
    wav.write(b"data")
    wav.write(struct.pack("<I", data_size))

    # 写入静音数据（全零）
    wav.write(b"\x00" * data_size)

    return wav.getvalue()


async def transcribe_audio(audio_bytes: bytes, format: str = "wav") -> str:
    """
    ASR：将语音转为文字。
    若 Whisper API 可用则调用，否则返回 mock 文字。
    """
    settings = get_settings()

    # 尝试调用 Whisper API
    if settings.llm_api_key and settings.llm_api_key != "your_llm_api_key_here":
        try:
            return await _call_whisper(audio_bytes, format, settings)
        except Exception:
            pass

    # Mock 模式
    return _mock_transcribe(audio_bytes)


async def _call_whisper(audio_bytes: bytes, format: str, settings) -> str:
    """调用 OpenAI Whisper API"""
    async with httpx.AsyncClient(timeout=30.0) as client:
        files = {"file": (f"audio.{format}", audio_bytes, f"audio/{format}")}
        resp = await client.post(
            f"{settings.llm_base_url}/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {settings.llm_api_key}"},
            data={"model": "whisper-1", "language": "zh"},
            files=files,
        )
        data = resp.json()
        return data.get("text", "")


def _mock_transcribe(audio_bytes: bytes) -> str:
    """Mock 模式：根据音频大小返回模拟文字"""
    size_kb = len(audio_bytes) / 1024
    if size_kb < 5:
        return "嗯..."
    elif size_kb < 20:
        return "今天天气真好呀..."
    else:
        return "静静...静静好想你的...今天过得怎么样呀？"
