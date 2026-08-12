// Registry of models the assistant may use (all hosted on Workers AI). The capability flags drive both the UI and the runtime behaviour.
// ctx is a rough context window in tokens, used as the threshold for automatic history compaction
// AI 助手可用模型注册表(全部 Workers AI 托管模型,能力标记决定 UI 与运行行为)
// ctx 为粗略上下文窗口(tokens),用于历史自动压缩阈值

export interface ChatModel {
  id: string;
  label: string;
  desc: string;        // 选择器里的一句话说明
  ctx: number;
  tools: boolean;      // 支持函数调用(联网搜索/画图等工具)
  vision: boolean;     // 支持图片输入
  reasoning: boolean;  // 会输出思考过程
  thinkTag?: boolean;  // 思考混在正文里以 <think> 标签输出,需要拆分
}

export const CHAT_MODELS: ChatModel[] = [
  {
    id: '@cf/moonshotai/kimi-k2.6',
    label: 'Kimi K2.6',
    desc: '旗舰全能:推理 + 识图 + 工具',
    ctx: 200_000, tools: true, vision: true, reasoning: true,
  },
  {
    id: '@cf/zai-org/glm-4.7-flash',
    label: 'GLM 4.7 Flash',
    desc: '快速轻量:推理 + 工具,日常首选',
    ctx: 131_000, tools: true, vision: false, reasoning: true,
  },
  {
    id: '@cf/openai/gpt-oss-120b',
    label: 'GPT-OSS 120B',
    desc: 'OpenAI 开源旗舰:深度推理 + 工具',
    ctx: 128_000, tools: true, vision: false, reasoning: true,
  },
  {
    id: '@cf/meta/llama-4-scout-17b-16e-instruct',
    label: 'Llama 4 Scout',
    desc: '多模态:识图 + 工具',
    ctx: 131_000, tools: true, vision: true, reasoning: false,
  },
  {
    id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    label: 'Llama 3.3 70B',
    desc: '经典稳定:工具调用成熟',
    ctx: 24_000, tools: true, vision: false, reasoning: false,
  },
  {
    id: '@cf/qwen/qwen3-30b-a3b-fp8',
    label: 'Qwen3 30B',
    desc: '混合推理 + 工具',
    ctx: 32_000, tools: true, vision: false, reasoning: true, thinkTag: true,
  },
  {
    id: '@cf/mistralai/mistral-small-3.1-24b-instruct',
    label: 'Mistral Small 3.1',
    desc: '识图 + 工具',
    ctx: 128_000, tools: true, vision: true, reasoning: false,
  },
  {
    id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
    label: 'DeepSeek R1 Distill',
    desc: '纯推理模型(不带工具)',
    ctx: 80_000, tools: false, vision: false, reasoning: true, thinkTag: true,
  },
  {
    id: '@cf/google/gemma-4-26b-a4b-it',
    label: 'Gemma 4 26B',
    desc: '谷歌开源:多语言对话',
    ctx: 80_000, tools: false, vision: false, reasoning: false,
  },
  {
    id: '@cf/qwen/qwen2.5-coder-32b-instruct',
    label: 'Qwen2.5 Coder 32B',
    desc: '代码专精',
    ctx: 32_000, tools: false, vision: false, reasoning: false,
  },
];

export const DEFAULT_MODEL = '@cf/zai-org/glm-4.7-flash';

// Fixed internal models: title generation, memory extraction, history summarisation. None of these appear in any picker.
// 内部固定模型:标题生成/记忆提取/历史摘要(不进任何选择器)
export const UTILITY_MODEL = '@cf/zai-org/glm-4.7-flash';

export function getChatModel(id: string): ChatModel | null {
  return CHAT_MODELS.find((m) => m.id === id) || null;
}

// ---------- Capability models (one default each, configured per domain in the admin console) ----------
// ---------- 能力模型(按域名各选一个默认,在后台配置) ----------

export interface CapModel {
  id: string;
  label: string;
}

// Vision: used to turn an image into a text description when the chat model is not multimodal
// 识图:对话模型不支持多模态时,用它把图片转成文字描述
export const VISION_MODELS: CapModel[] = [
  { id: '@cf/moonshotai/kimi-k2.6', label: 'Kimi K2.6' },
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout' },
  { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', label: 'Mistral Small 3.1' },
  { id: '@cf/meta/llama-3.2-11b-vision-instruct', label: 'Llama 3.2 11B Vision' },
];
export const DEFAULT_VISION = '@cf/moonshotai/kimi-k2.6';

// Speech recognition (transcribing audio attachments)
// 语音识别(附件里的音频转写)
export const ASR_MODELS: CapModel[] = [
  { id: '@cf/openai/whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo' },
  { id: '@cf/openai/whisper', label: 'Whisper' },
  { id: '@cf/deepgram/nova-3', label: 'Deepgram Nova 3' },
  { id: '@cf/openai/whisper-tiny-en', label: 'Whisper Tiny (英文)' },
];
export const DEFAULT_ASR = '@cf/openai/whisper-large-v3-turbo';

// Speech synthesis (reading assistant replies aloud)
// 语音合成(朗读助手回复)
export const TTS_MODELS: CapModel[] = [
  { id: '@cf/deepgram/aura-1', label: 'Deepgram Aura 1 (英文)' },
  { id: '@cf/deepgram/aura-2-en', label: 'Deepgram Aura 2 (英文)' },
  { id: '@cf/deepgram/aura-2-es', label: 'Deepgram Aura 2 (西语)' },
  { id: '@cf/myshell-ai/melotts', label: 'MeloTTS (多语言)' },
];
export const DEFAULT_TTS = '@cf/deepgram/aura-1';

// Text to image (the generate_image tool)
// 文生图(generate_image 工具)
export const IMAGE_MODELS: CapModel[] = [
  { id: '@cf/black-forest-labs/flux-1-schnell', label: 'FLUX.1 Schnell (快)' },
  { id: '@cf/black-forest-labs/flux-2-klein-4b', label: 'FLUX.2 Klein 4B' },
  { id: '@cf/black-forest-labs/flux-2-klein-9b', label: 'FLUX.2 Klein 9B' },
  { id: '@cf/black-forest-labs/flux-2-dev', label: 'FLUX.2 Dev (高质量)' },
  { id: '@cf/leonardo/lucid-origin', label: 'Leonardo Lucid Origin' },
  { id: '@cf/leonardo/phoenix-1.0', label: 'Leonardo Phoenix' },
  { id: '@cf/stabilityai/stable-diffusion-xl-base-1.0', label: 'SDXL Base' },
  { id: '@cf/bytedance/stable-diffusion-xl-lightning', label: 'SDXL Lightning' },
  { id: '@cf/lykon/dreamshaper-8-lcm', label: 'DreamShaper 8' },
];
export const DEFAULT_IMAGE = '@cf/black-forest-labs/flux-1-schnell';

export function pickCap(models: CapModel[], id: string | null | undefined, fallback: string): string {
  return models.some((m) => m.id === id) ? (id as string) : fallback;
}
