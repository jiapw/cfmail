-- Per-domain model management: which chat models users may pick, plus the default
-- model for each of the four capability classes.
-- 按域名的模型管理:允许用户选用的对话模型清单 + 四类能力模型默认
-- JSON array; NULL or an empty array means all are allowed / JSON 数组;NULL/空数组 = 全部允许
ALTER TABLE domains ADD COLUMN chat_models TEXT;
-- Vision: fallback when the chat model is not multimodal / 识图:对话模型不支持多模态时兜底
ALTER TABLE domains ADD COLUMN chat_vision_model TEXT;
-- Speech recognition (attachment transcription) / 语音识别(附件转写)
ALTER TABLE domains ADD COLUMN chat_asr_model TEXT;
-- Speech synthesis (reading replies aloud) / 语音合成(朗读回复)
ALTER TABLE domains ADD COLUMN chat_tts_model TEXT;
-- Text to image (the image generation tool) / 文生图(生成图片工具)
ALTER TABLE domains ADD COLUMN chat_image_model TEXT;
