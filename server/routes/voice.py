"""语音 API：TTS 生成 + ASR 转写"""
from __future__ import annotations

from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from services.tts_service import generate_tts, transcribe_audio

router = APIRouter(prefix="/api/voice", tags=["voice"])


class TTSRequest(BaseModel):
    text: str
    voice_id: str = "default"


@router.post("/tts")
async def text_to_speech(body: TTSRequest):
    """
    文本转语音。
    返回 WAV 音频（base64 编码的 JSON，或直接返回二进制）。
    """
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="文本不能为空")
    if len(body.text) > 500:
        raise HTTPException(status_code=400, detail="文本过长（最多 500 字）")

    audio_bytes = await generate_tts(body.text, body.voice_id)
    if not audio_bytes:
        raise HTTPException(status_code=500, detail="TTS 生成失败")

    # 返回 base64 编码的音频
    import base64
    audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")
    return {
        "audio": audio_base64,
        "format": "wav",
        "duration": _estimate_duration(body.text),
    }


@router.post("/asr")
async def speech_to_text(
    audio: UploadFile = File(...),
    format: str = Form("wav"),
):
    """
    语音转文字。
    接收音频文件，返回转写文字。
    """
    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="音频文件为空")

    text = await transcribe_audio(audio_bytes, format)
    return {"text": text}


def _estimate_duration(text: str) -> float:
    """估算语音时长（秒）"""
    return max(1.0, min(60.0, len(text) / 4.0))
