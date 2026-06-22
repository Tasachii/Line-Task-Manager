import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { AppConfigService } from '../config/app-config.service';
import { TaskPriority } from './dto/task.types';

export interface ExtractedTask {
  title: string;
  description: string;
  priority?: TaskPriority;
  dueDate?: string; // YYYY-MM-DD
}

// Shape of the structured output produced by Claude per EXTRACT_SCHEMA.
interface ExtractionResult {
  tasks: {
    title: string;
    description: string;
    priority?: TaskPriority;
    due_date?: string | null;
  }[];
}

// JSON schema for Claude's structured output — enforces this exact response shape.
const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'หัวข้องานสั้นๆ ไม่เกิน 60 ตัวอักษร' },
          description: { type: 'string', description: 'รายละเอียดงานเต็มๆ' },
          priority: { type: 'string', enum: ['low', 'medium', 'high'] },
          due_date: {
            type: ['string', 'null'],
            description: 'กำหนดส่งรูปแบบ YYYY-MM-DD ถ้าระบุในข้อความ ไม่มีให้เป็น null',
          },
        },
        required: ['title', 'description'],
        additionalProperties: false,
      },
    },
  },
  required: ['tasks'],
  additionalProperties: false,
} as const;

const AI_SYSTEM_PROMPT = `คุณคือตัวคัดกรองข้อความจากกลุ่ม LINE ของทีมพัฒนาซอฟต์แวร์กับลูกค้า
หน้าที่: ตัดสินว่าข้อความเป็น "งาน" หรือไม่ (requirement, ขอแก้บั๊ก, ขอฟีเจอร์, สั่งงาน)
- ถ้าเป็นแค่บทสนทนาทั่วไป ทักทาย ถามไถ่ ขอบคุณ → ตอบ tasks เป็น array ว่าง
- ถ้าเป็นงาน → แตกเป็นรายการงาน (1 ข้อความอาจมีหลายงาน) หัวข้อกระชับ รายละเอียดครบ
- ระบุ priority เมื่อข้อความสื่อความเร่งด่วน (ด่วน/ASAP → high)
- ระบุ due_date (YYYY-MM-DD) เฉพาะเมื่อข้อความระบุวันชัดเจน
อย่าเดางานจากข้อความที่กำกวม — สงสัยให้ตอบ array ว่าง`;

@Injectable()
export class TaskExtractionService {
  private readonly logger = new Logger(TaskExtractionService.name);
  private readonly keyword: string;

  // AI extraction is optional — enabled only when ANTHROPIC_API_KEY is set.
  private readonly anthropic: Anthropic | null;
  // Default to Haiku: extraction is a lightweight classify-and-split task, so the cheapest
  // capable model is the right default. Override with AI_EXTRACT_MODEL for higher accuracy.
  private readonly aiModel: string;

  constructor(private readonly config: AppConfigService) {
    this.keyword = this.config.taskKeyword;
    this.anthropic = this.config.anthropicApiKey
      ? new Anthropic({ apiKey: this.config.anthropicApiKey, timeout: 15_000, maxRetries: 1 })
      : null;
    this.aiModel = this.config.aiExtractModel;
  }

  async extract(message: string): Promise<ExtractedTask[]> {
    const trimmed = message.trim();

    // 1) Message starts with keyword — parse directly, never call AI.
    if (trimmed.toLowerCase().startsWith(this.keyword.toLowerCase())) {
      return this.extractByKeyword(trimmed);
    }

    // 2) No keyword — delegate to AI if enabled, otherwise skip.
    if (this.anthropic) {
      return this.extractByAI(message);
    }
    return [];
  }

  // Multiple lines = multiple tasks (FR-2.2). Special tokens: !high/!low/!ด่วน and @YYYY-MM-DD.
  private extractByKeyword(trimmed: string): ExtractedTask[] {
    const body = trimmed.slice(this.keyword.length).trim();
    if (!body) return [];

    return body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => this.parseLine(line));
  }

  private parseLine(line: string): ExtractedTask {
    let priority: TaskPriority | undefined;
    let dueDate: string | undefined;

    const due = line.match(/@(\d{4}-\d{2}-\d{2})/);
    if (due) {
      dueDate = due[1];
      line = line.replace(due[0], '').trim();
    }
    if (/!(high|สูง|ด่วน)/iu.test(line)) {
      priority = 'high';
      line = line.replace(/!(high|สูง|ด่วน)/giu, '').trim();
    } else if (/!(low|ต่ำ)/iu.test(line)) {
      priority = 'low';
      line = line.replace(/!(low|ต่ำ)/giu, '').trim();
    }

    return { title: this.truncateTitle(line), description: line, priority, dueDate };
  }

  // Truncate to 60 visible graphemes — Thai vowels/tone marks are never split mid-character.
  private truncateTitle(text: string): string {
    const graphemes = [...new Intl.Segmenter('th', { granularity: 'grapheme' }).segment(text)];
    if (graphemes.length <= 60) return text;
    return graphemes.slice(0, 60).map((g) => g.segment).join('') + '…';
  }

  // Ask Claude to classify the message — returns [] on error or timeout (fail-open, never blocks the webhook).
  private async extractByAI(message: string): Promise<ExtractedTask[]> {
    try {
      const res = await this.anthropic!.messages.create({
        model: this.aiModel,
        max_tokens: 2048,
        system: AI_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: message }],
        output_config: { format: { type: 'json_schema', schema: EXTRACT_SCHEMA } },
      });

      const parsed = this.parseExtraction(res);
      if (!parsed) return [];
      return parsed.tasks.map((t) => ({
        title: this.truncateTitle(t.title),
        description: t.description,
        priority: t.priority,
        dueDate: t.due_date ?? undefined,
      }));
    } catch (e) {
      this.logger.warn(`AI extract failed (fail-open, skip message): ${(e as Error).message}`);
      return [];
    }
  }

  // With output_config.format the SDK surfaces the structured result in `parsed_output`;
  // the assistant turn is not guaranteed to also include a plain text block. Read
  // `parsed_output` first, then fall back to the first text block for older shapes.
  private parseExtraction(res: Anthropic.Message): ExtractionResult | null {
    const fromParsed = (res as { parsed_output?: unknown }).parsed_output;
    if (fromParsed && typeof fromParsed === 'object') {
      return fromParsed as ExtractionResult;
    }
    const text = res.content.find((b) => b.type === 'text')?.text;
    if (!text) return null;
    return JSON.parse(text) as ExtractionResult;
  }
}
