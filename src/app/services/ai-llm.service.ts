import { Injectable } from '@angular/core';
import { SortPairRow } from './data.service';
import { GRID_SCHEMA } from './grid-schema';

export interface LlmConfig {
  provider: 'groq' | 'openai' | 'gemini' | 'grok' | 'ollama' | 'custom';
  apiKey: string;
  model: string;
  baseUrl: string;
}

export interface LlmAction {
  type: string;
  columns?: string[];
  filters?: LlmFilter[];
  sortField?: string;
  sortDir?: 'asc' | 'desc';
  n?: number;
  statType?: string;
  email?: string;
  explanation?: string;
  // used by "analysis" type — LLM's free-text answer based on actual data
  text?: string;
  gridActions?: LlmAction[];
}

export interface LlmFilter {
  field: string;
  op: string;
  value?: string | number;
  from?: number;
  to?: number;
}

export const LLM_PRESETS: Record<string, { baseUrl: string; model: string; note: string }> = {
  groq:   { baseUrl: 'https://api.groq.com/openai/v1',  model: 'llama-3.1-8b-instant', note: 'Recommended — free, fast & browser-friendly (no CORS issues). Key: console.groq.com' },
  openai: { baseUrl: 'https://api.openai.com/v1',        model: 'gpt-4o-mini',           note: 'Needs a paid key WITH credits. Use model gpt-4o-mini or gpt-4o. (Browser calls may hit CORS — use a backend proxy in prod.)' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-1.5-flash', note: 'Google Gemini via its OpenAI-compatible endpoint. Free tier available. Key: aistudio.google.com' },
  grok:   { baseUrl: 'https://api.x.ai/v1',              model: 'grok-2',                note: 'xAI Grok — OpenAI-compatible. Paid key from console.x.ai.' },
  ollama: { baseUrl: 'http://localhost:11434/v1',         model: 'llama3.2',              note: 'Local — no key needed. Run "ollama serve" & "ollama pull llama3.2" first.' },
  custom: { baseUrl: '',                                  model: '',                      note: 'Any OpenAI-compatible endpoint (must allow browser/CORS).' },
};

const STORAGE_KEY = 'ag-grid-ai-llm-cfg';

// ─── System prompt — includes ACTUAL row data so LLM can do real analysis ─────
function buildSystemPrompt(rows: SortPairRow[]): string {
  // Compact JSON — one row per line to save tokens
  const dataJson = rows.map(r => JSON.stringify(r)).join('\n');

  // Column schema & groups are generated from the shared GRID_SCHEMA.
  const kindLabel = (k: string) => k === 'number' ? 'numeric' : (k === 'date' ? 'text, date MM/DD/YYYY' : 'text');
  const schemaLines = GRID_SCHEMA.fields
    .map(f => `  ${f.id.padEnd(15)} : ${f.label} (${kindLabel(f.kind)})`)
    .join('\n');
  const groupLines = GRID_SCHEMA.groups
    .map(g => `  "${g.header}"${' '.repeat(Math.max(1, 20 - g.header.length))}→ [${g.fields.join(', ')}]`)
    .join('\n');

  return `You are an AI data analyst AND AG Grid table controller.
You have direct access to ALL ${rows.length} rows of the actual dataset shown below.

━━━ LIVE DATA (${rows.length} rows) ━━━
${dataJson}

━━━ COLUMN SCHEMA ━━━
${schemaLines}

COLUMN GROUPS:
${groupLines}

━━━ RESPOND ONLY WITH: {"actions":[...]} ━━━

▶ ANALYSIS / QUESTIONS (use this when user asks a question or wants insights):
  {"type":"analysis","text":"Your detailed answer here — include specific numbers, names, percentages from the actual data rows above","gridActions":[...optional grid control actions...],"explanation":"what you did"}

▶ GRID CONTROL ACTIONS:
  hide-columns      : {"type":"hide-columns","columns":["submittedUser","targetDateStart"]}
  show-columns      : {"type":"show-columns","columns":["id","number"]}
  show-all-columns  : {"type":"show-all-columns"}
  hide-all-except   : {"type":"hide-all-except","columns":["id","number"]}  ← for "except X" / "only X"
  filter            : {"type":"filter","filters":[{"field":"submittedUser","op":"contains","value":"Vignesh"}]}
  clear-filters     : {"type":"clear-filters"}
  sort              : {"type":"sort","sortField":"submittedDate","sortDir":"desc"}
  show-last         : {"type":"show-last","n":10}
  show-first        : {"type":"show-first","n":10}
  page-size         : {"type":"page-size","n":20}
  page-goto         : {"type":"page-goto","n":2}
  disable-pagination: {"type":"disable-pagination"}  ← "no pagination" / "all data"
  enable-pagination : {"type":"enable-pagination"}
  select-all        : {"type":"select-all"}
  deselect-all      : {"type":"deselect-all"}
  export-csv        : {"type":"export-csv"}
  send-mail         : {"type":"send-mail","email":"user@example.com"}
  auto-size         : {"type":"auto-size"}
  reset             : {"type":"reset"}
  stats             : {"type":"stats","statType":"distribution"}
  help              : {"type":"help"}

FILTER OPERATORS: contains | notContains | equals | notEqual | startsWith | endsWith | blank | notBlank | greaterThan | lessThan | greaterThanOrEqual | lessThanOrEqual | inRange

CRITICAL RULES:
1. "except [X]" / "only show [X]" / "hide all but [X]" → hide-all-except (columns = what to KEEP)
2. "without pagination" / "show all" / "no paging"      → disable-pagination
3. Column groups expand to their fields (e.g. "Target Date Range" → targetDateStart + targetDateEnd)
4. For analysis: read the actual data rows above and give real answers with numbers/names
5. Combine analysis + gridActions when it makes sense (e.g. show insight AND filter to relevant rows)
6. Multiple actions: put them all in the "actions" array
7. OR on the SAME column (e.g. comments contains 'schema' OR 'test') → emit MULTIPLE filter
   objects with the SAME field, one per value:
   {"type":"filter","filters":[{"field":"comments","op":"contains","value":"schema"},{"field":"comments","op":"contains","value":"test"}]}
8. AND across DIFFERENT columns → one filter object per column in the same filters array.
9. Always add "explanation" per action
10. Return ONLY valid JSON — absolutely nothing outside the JSON`;
}

@Injectable({ providedIn: 'root' })
export class AiLlmService {
  private config: LlmConfig | null = null;

  constructor() {
    this.loadConfig();
  }

  loadConfig(): LlmConfig | null {
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      if (s) this.config = JSON.parse(s);
    } catch { /* ignore */ }
    return this.config;
  }

  setConfig(c: LlmConfig): void {
    this.config = c;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  }

  clearConfig(): void {
    this.config = null;
    localStorage.removeItem(STORAGE_KEY);
  }

  isConfigured(): boolean {
    return !!(this.config?.apiKey && this.config?.baseUrl && this.config?.model);
  }

  getConfig(): LlmConfig | null { return this.config; }

  async query(userMessage: string, rows: SortPairRow[]): Promise<LlmAction[]> {
    if (!this.isConfigured()) throw new Error('LLM not configured');
    const c = this.config!;

    // First attempt: with JSON mode (except Ollama). If the model rejects
    // response_format, retry once without it.
    const useJsonMode = c.provider !== 'ollama';
    let content: string;
    try {
      content = await this.callApi(userMessage, rows, useJsonMode);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Retry without json mode if the model/endpoint doesn't support it
      if (useJsonMode && /response_format|json_object|not supported|invalid.*format|400/i.test(msg)) {
        content = await this.callApi(userMessage, rows, false);
      } else {
        throw e;
      }
    }

    // Strip markdown fences some models add despite instructions
    let cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

    // If the model wrapped JSON in prose, try to extract the first {...} block
    if (!cleaned.startsWith('{')) {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) cleaned = m[0];
    }

    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(cleaned); }
    catch { throw new Error(`LLM returned non-JSON output: "${cleaned.slice(0, 160)}…"`); }

    const actions = parsed['actions'];
    return Array.isArray(actions) ? actions as LlmAction[] : [parsed as unknown as LlmAction];
  }

  /** Single API call. Throws with a human-readable message on any failure. */
  private async callApi(userMessage: string, rows: SortPairRow[], jsonMode: boolean): Promise<string> {
    const c = this.config!;

    const body: Record<string, unknown> = {
      model: c.model,
      messages: [
        { role: 'system', content: buildSystemPrompt(rows) },
        { role: 'user',   content: userMessage },
      ],
      temperature: 0.1,
      max_tokens: 1200,
    };
    if (jsonMode) {
      body['response_format'] = { type: 'json_object' };
    }

    let resp: Response;
    try {
      resp = await fetch(`${c.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${c.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch {
      // fetch() only rejects on network-level failures (CORS, DNS, offline)
      throw new Error(
        `Network/CORS error reaching ${c.baseUrl}. ` +
        (c.provider === 'openai'
          ? 'OpenAI blocks direct browser calls from some setups — use Groq (browser-friendly) or a local proxy.'
          : 'Check the Base URL, your connection, or that the server allows browser (CORS) requests.')
      );
    }

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({})) as Record<string, unknown>;
      const apiError = (errBody?.['error'] as Record<string, unknown>)?.['message'] as string || resp.statusText;
      const code = (errBody?.['error'] as Record<string, unknown>)?.['code'] as string;
      // Friendlier hints for the most common status codes
      let hint = '';
      if (resp.status === 401) hint = ' — API key is invalid or missing.';
      else if (resp.status === 404) hint = ` — model "${c.model}" not found at this endpoint. Check the model name.`;
      else if (resp.status === 429) hint = ' — rate limit or quota exceeded (billing/credits).';
      else if (resp.status >= 500) hint = ' — the provider is having server issues, try again.';
      throw new Error(`API ${resp.status}${code ? ' ('+code+')' : ''}: ${apiError}${hint}`);
    }

    const data = await resp.json() as Record<string, unknown>;
    const choices = data['choices'] as Array<Record<string, unknown>>;
    return (choices?.[0]?.['message'] as Record<string, unknown>)?.['content'] as string ?? '{}';
  }


  async testConnection(rows: SortPairRow[]): Promise<string> {
    const actions = await this.query('How many rows are in the dataset? Who are the submitters?', rows);
    const analysis = actions.find(a => a.type === 'analysis');
    if (analysis?.text) return `✅ Connected — LLM answered: "${analysis.text.slice(0, 100)}..."`;
    const first = actions[0];
    return `✅ Connected — LLM responded with action: ${first?.type} (${first?.explanation || 'no explanation'})`;
  }
}

