import { Injectable } from '@angular/core';
import { GridApi } from 'ag-grid-community';
import { SortPairRow } from './data.service';
import { AiLlmService, LlmAction, LlmFilter } from './ai-llm.service';
import { GRID_SCHEMA, ALL_FIELD_IDS, DATE_FIELD_IDS, filterTypeOf } from './grid-schema';

// ─── Public types ─────────────────────────────────────────────────────────────
export interface CommandResult {
  success: boolean;
  message: string;
  action?: 'export-csv' | 'send-mail';
  mailTo?: string;
  parseInfo?: ParseInfo;
  statResult?: StatResult;
}
export interface ParseInfo {
  intent: string; intentLabel: string; confidence: number;
  entities: EntityItem[]; interpretation: string;
}
export interface EntityItem {
  type: 'column' | 'operator' | 'value' | 'number' | 'direction' | 'email'; label: string; value: string;
}
export interface StatResult {
  type: 'count' | 'avg' | 'sum' | 'max' | 'min' | 'distribution';
  field?: string; value: number; rows: number;
  breakdown?: { label: string; count: number; pct: number }[];
}

// ─── Column metadata (derived from the shared GRID_SCHEMA) ────────────────────
interface ColMeta { id: string; label: string; filterType: 'text' | 'number'; aliases: string[]; }

const COLS: ColMeta[] = GRID_SCHEMA.fields.map(f => ({
  id: f.id, label: f.label, filterType: filterTypeOf(f.kind), aliases: f.aliases,
}));

const ALL_COL_IDS = ALL_FIELD_IDS;
const DATE_COL_IDS = new Set(DATE_FIELD_IDS);

// Column groups (alias → field ids) for column visibility — derived from schema.
const COL_GROUPS: Record<string, string[]> = (() => {
  const m: Record<string, string[]> = {};
  for (const g of GRID_SCHEMA.groups) for (const a of g.aliases) m[a] = g.fields;
  m['all'] = ALL_FIELD_IDS;
  return m;
})();

// Date targets (alias → date column ids) for the natural-language date engine.
// Range groups are listed first so "target date range" wins over a bare "date".
const DATE_TARGETS: { aliases: string[]; cols: string[] }[] = (() => {
  const list: { aliases: string[]; cols: string[] }[] = [];
  for (const g of GRID_SCHEMA.groups) {
    if (g.isDateRange) list.push({ aliases: g.aliases, cols: g.fields.filter(id => DATE_COL_IDS.has(id)) });
  }
  for (const f of GRID_SCHEMA.fields) {
    if (f.kind === 'date') list.push({ aliases: f.aliases, cols: [f.id] });
  }
  return list;
})();

// ─── Operator table ───────────────────────────────────────────────────────────
const OPS: { agOp: string; keywords: string[] }[] = [
  { agOp: 'notBlank',           keywords: ['not empty','not blank','has value','filled','not null','has comment','has comments','with comments','has remarks','not missing','exists','is filled'] },
  { agOp: 'blank',              keywords: ['empty','blank','null','missing','no value','no comment','no comments','no remarks','is empty','is blank','is null'] },
  { agOp: 'notContains',        keywords: ['not contains','not containing','does not contain','excluding','without','except','not including','not having','not like'] },
  { agOp: 'startsWith',         keywords: ['starts with','starting with','begins with','beginning with','prefixed with'] },
  { agOp: 'endsWith',           keywords: ['ends with','ending with','ends in','ending in','suffixed with'] },
  { agOp: 'inRange',            keywords: ['between','in range'] },
  { agOp: 'greaterThanOrEqual', keywords: ['at least','>=','minimum','no less than','not less than','greater than or equal to'] },
  { agOp: 'lessThanOrEqual',    keywords: ['at most','<=','maximum','no more than','not more than','up to','less than or equal to'] },
  { agOp: 'greaterThan',        keywords: ['greater than','more than','>','above','over','exceeds','bigger than','larger than','higher than'] },
  { agOp: 'lessThan',           keywords: ['less than','fewer than','<','below','under','smaller than','lower than'] },
  { agOp: 'notEqual',           keywords: ['not equals','not equal to','is not','are not',"isn't",'!=','<>','different from','not same as'] },
  { agOp: 'equals',             keywords: ['equals','equal to','is exactly','exactly','==','matches exactly','same as'] },
  { agOp: 'contains',           keywords: ['contains','containing','includes','including','has','like','having','with','matching'] },
];

const NUMBER_WORDS: Record<string, number> = {
  'zero':0,'one':1,'two':2,'three':3,'four':4,'five':5,'six':6,'seven':7,'eight':8,
  'nine':9,'ten':10,'eleven':11,'twelve':12,'fifteen':15,'twenty':20,'thirty':30,
  'fifty':50,'hundred':100,'a few':3,
};

const INTENT_LABELS: Record<string, string> = {
  'filter':'🔍 Filter','sort':'↕ Sort','show-last':'📋 Last N','show-first':'📋 First N',
  'page-size':'📄 Page Size','page-goto':'📄 Navigate','export-csv':'📦 Export',
  'send-mail':'✉ Mail','select-all':'☑ Select','deselect-all':'☑ Deselect',
  'hide-col':'👁 Hide','show-col':'👁 Show','show-all-cols':'👁 All Cols',
  'auto-size':'↔ Auto-size','reset':'🔄 Reset','clear-filters':'🔄 Clear',
  'stats-count':'📊 Count','stats-avg':'📊 Avg','stats-sum':'📊 Sum',
  'stats-max':'📊 Max','stats-min':'📊 Min','stats-distribution':'📊 Distribution',
  'help':'❓ Help','compound':'⛓ Chain','unknown':'❓ Unknown',
  'analysis':'🧠 AI Analysis',
};

interface CondEx { field: string; filterType: 'text'|'number'; agOp: string; value: string|number|null; from?: number; to?: number; values?: (string|number)[]; isDate?: boolean; dateCols?: string[]; dateOp?: 'inRange'|'after'|'before'|'on'; dateFrom?: number|null; dateTo?: number|null; }
// A parsed natural-language date condition applied via AG Grid's external filter.
interface DateCond { cols: string[]; op: 'inRange'|'after'|'before'|'on'; from: number|null; to: number|null; }

@Injectable({ providedIn: 'root' })
export class AiCommandService {
  private allRows: SortPairRow[] = [];
  private gridApi: GridApi<SortPairRow> | null = null;
  private setRowDataFn: ((rows: SortPairRow[]) => void) | null = null;
  private setPaginationFn: ((enabled: boolean) => void) | null = null;
  /** Natural-language date filters, applied via AG Grid's external filter (AND-combined with column filters). */
  private dateFilters: DateCond[] = [];

  private static readonly MONTHS: Record<string, number> = {
    jan:0,january:0,feb:1,february:1,mar:2,march:2,apr:3,april:3,may:4,jun:5,june:5,
    jul:6,july:6,aug:7,august:7,sep:8,sept:8,september:8,oct:9,october:9,nov:10,november:10,dec:11,december:11,
  };

  constructor(private llm: AiLlmService) {}

  initialize(
    api: GridApi<SortPairRow>,
    allRows: SortPairRow[],
    setRowDataFn: (rows: SortPairRow[]) => void,
    setPaginationFn: (enabled: boolean) => void,
  ): void {
    this.gridApi = api;
    this.allRows = allRows;
    this.setRowDataFn = setRowDataFn;
    this.setPaginationFn = setPaginationFn;
    // Register the external filter so natural-language DATE filters work on
    // the text-formatted date columns (they can't use AG Grid's text inRange).
    this.gridApi.setGridOption('isExternalFilterPresent', () => this.dateFilters.length > 0);
    this.gridApi.setGridOption('doesExternalFilterPass', (node: { data?: SortPairRow }) =>
      node.data ? this.passesDateFilters(node.data) : true);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PUBLIC ENTRY POINT — always async
  // ═══════════════════════════════════════════════════════════════════════════
  async process(input: string): Promise<CommandResult> {
    if (!this.gridApi) return { success: false, message: 'Grid not ready.' };

    // ── Try LLM first if configured ──────────────────────────────────────────
    if (this.llm.isConfigured()) {
      try {
        // Pass the ACTUAL rows so the LLM can read and analyze the data
        const actions = await this.llm.query(input, this.allRows);
        if (actions?.length) {
          return this.executeLlmActions(actions);
        }
        throw new Error('LLM returned no actions.');
      } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.warn('LLM failed, falling back to rule-based NLU:', errMsg);
        // Surface the error so the user knows WHY the LLM did not run,
        // then still attempt the rule-based engine as a graceful fallback.
        const fallback = this.processRuleBased(input.trim());
        return {
          ...fallback,
          message: `⚠ LLM error — used rule-based engine instead.\n   ${errMsg}\n\n${fallback.message}`,
          parseInfo: fallback.parseInfo
            ? { ...fallback.parseInfo, intentLabel: `⚠ Fallback · ${fallback.parseInfo.intentLabel}` }
            : fallback.parseInfo,
        };
      }
    }

    // ── Rule-based NLU (no LLM configured) ────────────────────────────────────
    return this.processRuleBased(input.trim());
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  LLM ACTION EXECUTOR
  // ═══════════════════════════════════════════════════════════════════════════
  private executeLlmActions(actions: LlmAction[]): CommandResult {
    const msgs: string[] = [];
    const ents: EntityItem[] = [];
    let exportAction: 'export-csv' | 'send-mail' | undefined;
    let mailTo = '';
    let anyFail = false;
    let hasAnalysis = false;

    for (const a of actions) {
      const r = this.execAction(a);
      msgs.push(r.message);
      if (r.action) exportAction = r.action;
      if (r.mailTo) mailTo = r.mailTo;
      if (!r.success) anyFail = true;
      if (a.type === 'analysis') hasAnalysis = true;
      if (a.explanation) ents.push({ type: 'value', label: 'AI understood', value: a.explanation });
    }

    const allTypes = actions.map(a => a.type).join(' + ');
    return {
      success: !anyFail,
      message: msgs.join('\n'),
      action: exportAction, mailTo,
      parseInfo: {
        intent: hasAnalysis ? 'analysis' : (actions.length === 1 ? actions[0].type : 'compound'),
        intentLabel: hasAnalysis ? '🧠 AI Analysis' : `🤖 AI — ${allTypes}`,
        confidence: 0.97,
        entities: ents,
        interpretation: `[LLM: ${this.llm.getConfig()?.model ?? 'unknown'}] ${actions.map(a => a.explanation || a.type).join(' → ')}`,
      },
    };
  }

  private execAction(a: LlmAction): CommandResult {
    switch (a.type) {
      // ── Column visibility ─────────────────────────────────────────────────
      case 'hide-columns': {
        const cols = this.expandCols(a.columns ?? []);
        if (!cols.length) return { success: false, message: `❌ No valid columns in: ${JSON.stringify(a.columns)}` };
        this.gridApi!.setColumnsVisible(cols, false);
        return this.ok('hide-col', `Hidden: ${cols.map(c => this.lbl(c)).join(', ')}`, []);
      }
      case 'show-columns': {
        const cols = this.expandCols(a.columns ?? []);
        if (!cols.length) return { success: false, message: `❌ No valid columns in: ${JSON.stringify(a.columns)}` };
        this.gridApi!.setColumnsVisible(cols, true);
        return this.ok('show-col', `Shown: ${cols.map(c => this.lbl(c)).join(', ')}`, []);
      }
      case 'show-all-columns': {
        this.gridApi!.setColumnsVisible(ALL_COL_IDS, true);
        return this.ok('show-all-cols', 'All columns visible.', []);
      }
      case 'hide-all-except': {
        const keep = this.expandCols(a.columns ?? []);
        const hide = ALL_COL_IDS.filter(c => !keep.includes(c));
        this.gridApi!.setColumnsVisible(ALL_COL_IDS, true);
        this.gridApi!.setColumnsVisible(hide, false);
        return this.ok('hide-col', `Showing only: ${keep.map(c => this.lbl(c)).join(', ')}`, []);
      }
      // ── AI Analysis — LLM's free-text answer based on actual data ─────────
      case 'analysis': {
        const text = a.text ?? a.explanation ?? '(No analysis text returned)';
        // Also execute any nested grid actions the LLM paired with the analysis
        if (Array.isArray(a.gridActions) && a.gridActions.length) {
          for (const ga of a.gridActions) {
            try { this.execAction(ga); } catch { /* best effort */ }
          }
          const gaTypes = a.gridActions.map(g => g.type).join(', ');
          return {
            success: true,
            message: `${text}\n\n─── Also applied: ${gaTypes}`,
            parseInfo: this.pi('analysis', 0.97, [{ type: 'value', label: 'Model', value: this.llm.getConfig()?.model ?? '?' }], '[LLM data analysis]'),
          };
        }
        return {
          success: true,
          message: text,
          parseInfo: this.pi('analysis', 0.97, [{ type: 'value', label: 'Model', value: this.llm.getConfig()?.model ?? '?' }], '[LLM data analysis]'),
        };
      }
      // ── Pagination ────────────────────────────────────────────────────────
      case 'disable-pagination': {
        this.setRowDataFn?.(this.allRows);
        this.setPaginationFn?.(false);
        return this.ok('page-size', `All ${this.allRows.length} rows shown — pagination disabled.`, []);
      }
      case 'enable-pagination': {
        this.setPaginationFn?.(true);
        this.gridApi!.setGridOption('paginationPageSize', 10);
        return this.ok('page-size', 'Pagination re-enabled (10 per page).', []);
      }
      case 'page-size': {
        const n = a.n ?? 10;
        this.gridApi!.setGridOption('paginationPageSize', n);
        return this.ok('page-size', n >= 9999 ? 'All rows on one page.' : `Page size → ${n}.`, []);
      }
      case 'page-goto': {
        this.gridApi!.paginationGoToPage((a.n ?? 1) - 1);
        return this.ok('page-goto', `Navigated to page ${a.n ?? 1}.`, []);
      }
      // ── Filter ────────────────────────────────────────────────────────────
      case 'filter': {
        const model: Record<string, unknown> = {};
        const descs: string[] = [];
        const dateFilters: DateCond[] = [];
        const DATE_COLS = DATE_COL_IDS;
        // Group filters by field so multiple values on the SAME column become an OR
        const byField: Record<string, LlmFilter[]> = {};
        for (const f of (a.filters ?? [])) { (byField[f.field] ||= []).push(f); }
        for (const [field, fs] of Object.entries(byField)) {
          const ft = COLS.find(c => c.id === field)?.filterType ?? 'text';
          // Date columns → route comparison/range operators through the external filter.
          if (DATE_COLS.has(field) && fs.every(f => ['inRange', 'greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual', 'equals'].includes(f.op))) {
            let handled = true;
            for (const f of fs) {
              const dc = f.op === 'inRange'
                ? this.buildDateCond([field], 'inRange', `${f.from} to ${f.to}`)
                : this.buildDateCond([field], f.op, String(f.value ?? ''));
              if (!dc) { handled = false; break; }
              dateFilters.push({ cols: dc.dateCols!, op: dc.dateOp!, from: dc.dateFrom ?? null, to: dc.dateTo ?? null });
              descs.push(this.descCond(dc));
            }
            if (handled) continue;
          }
          if (fs.length === 1) {
            const f = fs[0];
            const af: Record<string, unknown> = { filterType: ft, type: f.op };
            if (f.op !== 'blank' && f.op !== 'notBlank') {
              if (f.op === 'inRange') { af['filter'] = f.from; af['filterTo'] = f.to; }
              else af['filter'] = f.value;
            }
            model[field] = af;
            descs.push(`${this.lbl(field)} ${f.op} "${f.value ?? ''}"`);
          } else {
            // Multiple conditions on one field → OR them together
            model[field] = {
              filterType: ft,
              operator: 'OR',
              conditions: fs.map(f => ({ filterType: ft, type: f.op, filter: f.value })),
            };
            descs.push(`${this.lbl(field)} ${fs[0].op} (${fs.map(f => `"${f.value}"`).join(' OR ')})`);
          }
        }
        this.dateFilters = dateFilters;
        this.gridApi!.setFilterModel(Object.keys(model).length ? model : null);
        this.gridApi!.onFilterChanged();
        const vis = this.gridApi!.getDisplayedRowCount();
        return this.ok('filter', `${vis} row(s) match:\n  ${descs.join('\n  ')}`, []);
      }
      case 'clear-filters': {
        this.gridApi!.setFilterModel(null);
        this.dateFilters = [];
        this.gridApi!.onFilterChanged();
        this.setRowDataFn?.(this.allRows);
        return this.ok('clear-filters', `Filters cleared. ${this.allRows.length} rows visible.`, []);
      }
      // ── Sort ──────────────────────────────────────────────────────────────
      case 'sort': {
        const dir = (a.sortDir ?? 'asc') as 'asc' | 'desc';
        this.gridApi!.applyColumnState({ state: [{ colId: a.sortField!, sort: dir }], defaultState: { sort: null } });
        return this.ok('sort', `Sorted by "${this.lbl(a.sortField!)}" ${dir}.`, []);
      }
      // ── Row subsets ───────────────────────────────────────────────────────
      case 'show-last': {
        const n = a.n ?? 10;
        this.setRowDataFn?.([...this.allRows].sort((x, y) => y.id - x.id).slice(0, n));
        this.gridApi!.setGridOption('paginationPageSize', Math.min(n, 100));
        return this.ok('show-last', `Showing ${n} most recent rows.`, []);
      }
      case 'show-first': {
        const n = a.n ?? 10;
        this.setRowDataFn?.([...this.allRows].sort((x, y) => x.id - y.id).slice(0, n));
        this.gridApi!.setGridOption('paginationPageSize', Math.min(n, 100));
        return this.ok('show-first', `Showing ${n} earliest rows.`, []);
      }
      // ── Selection ─────────────────────────────────────────────────────────
      case 'select-all':   { this.gridApi!.selectAll();   return this.ok('select-all',   `${this.gridApi!.getSelectedRows().length} rows selected.`, []); }
      case 'deselect-all': { this.gridApi!.deselectAll(); return this.ok('deselect-all', 'All rows deselected.', []); }
      // ── Export ────────────────────────────────────────────────────────────
      case 'export-csv': return { success: true, message: '✅ Exporting as CSV...', action: 'export-csv', parseInfo: this.pi('export-csv', 0.97, [], 'Export CSV') };
      case 'send-mail':  return { success: true, message: `✅ Mail client opened${a.email ? ' to ' + a.email : ''}.`, action: 'send-mail', mailTo: a.email ?? '', parseInfo: this.pi('send-mail', 0.97, [], 'Send mail') };
      // ── Misc ──────────────────────────────────────────────────────────────
      case 'auto-size': { this.gridApi!.autoSizeAllColumns(); return this.ok('auto-size', 'Columns auto-sized.', []); }
      case 'reset': {
        this.gridApi!.setFilterModel(null);
        this.dateFilters = [];
        this.gridApi!.applyColumnState({ defaultState: { sort: null } });
        this.setRowDataFn?.(this.allRows);
        this.gridApi!.setColumnsVisible(ALL_COL_IDS, true);
        this.setPaginationFn?.(true);
        this.gridApi!.setGridOption('paginationPageSize', 10);
        return this.ok('reset', `Grid fully reset. ${this.allRows.length} rows.`, []);
      }
      case 'stats': {
        const r = this.tryStats((a.statType ?? 'count').replace('stats-', ''));
        return r ?? { success: false, message: '❌ Stats failed.' };
      }
      case 'help': return this.buildHelp();
      default: return { success: false, message: `⚠ Unknown action: "${a.type}"` };
    }
  }

  /** Expand a list that may contain field IDs or group names */
  private expandCols(input: string[]): string[] {
    const out: string[] = [];
    for (const raw of input) {
      const lower = raw.toLowerCase().trim();
      if (COL_GROUPS[lower]) { out.push(...COL_GROUPS[lower]); continue; }
      if (ALL_COL_IDS.includes(raw)) { out.push(raw); continue; }
      const found = this.findCol(lower);
      if (found) out.push(found);
    }
    return [...new Set(out)];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  RULE-BASED NLU  (fallback when no LLM configured)
  // ═══════════════════════════════════════════════════════════════════════════
  private processRuleBased(input: string): CommandResult {
    // Split a sentence like "sort by number and filter by user X and export"
    // into separate action segments and run each in order.
    const segments = this.splitIntoActions(input);
    if (segments.length > 1) return this.runCompound(segments);
    return this.runSingleIntent(input.trim());
  }

  /** Execute a chain of action segments and combine their results. */
  private runCompound(segments: string[]): CommandResult {
    const msgs: string[] = [];
    const ents: EntityItem[] = [];
    const labels: string[] = [];
    let exportAction: 'export-csv' | 'send-mail' | undefined;
    let mailTo = '';
    let anyFail = false;
    let mergeNext = false;   // once a filter runs in the chain, later filters AND onto it

    for (const seg of segments) {
      const r = this.runSingleIntent(seg.trim(), mergeNext);
      const cleaned = r.message.replace(/^[✅❌⚠]\s*/, '').split('\n')[0];
      msgs.push(`${r.success ? '✅' : '❌'} ${seg.trim()} → ${cleaned}`);
      if (r.action) exportAction = r.action;
      if (r.mailTo) mailTo = r.mailTo;
      if (!r.success) anyFail = true;
      if (r.parseInfo) { labels.push(r.parseInfo.intentLabel); ents.push(...r.parseInfo.entities); }
      // Chained filters accumulate (AND). A clear/reset in the chain starts fresh again.
      if (r.parseInfo?.intent === 'filter') mergeNext = true;
      else if (r.parseInfo?.intent === 'clear-filters' || r.parseInfo?.intent === 'reset') mergeNext = false;
    }

    return {
      success: !anyFail,
      message: `⛓ Ran ${segments.length} chained actions:\n${msgs.join('\n')}`,
      action: exportAction, mailTo,
      parseInfo: this.pi('compound', anyFail ? 0.6 : 0.92, ents, `Chain: ${labels.join(' → ')}`),
    };
  }

  /** Break input into distinct action segments (";", "then", "and/with <verb>"). */
  private splitIntoActions(input: string): string[] {
    // 1) Explicit separators
    const rawParts = input.split(/\s*;\s*|\s+then\s+(?:also\s+)?|\s+and\s+then\s+/i);
    // 2) Split on "and/with/,/. <action-verb>" so filter-condition "and"s stay intact
    const verb = '(?:sort|order|arrange|rank|filter|export|download|save\\s+as|send|mail|email|hide|unhide|reveal|display|select|deselect|clear|reset|refresh|auto\\s*-?size|group|show\\s+all\\s+columns?|show\\s+(?:the\\s+)?(?:last|first|top|bottom))';
    const splitRe = new RegExp(`\\s+(?:and|with)\\s+(?=${verb}\\b)|\\s*,\\s*(?=${verb}\\b)|\\s*\\.\\s+(?=${verb}\\b)`, 'i');
    const out: string[] = [];
    for (const p of rawParts) {
      out.push(...p.split(splitRe));
    }
    const segs = out.map(s => s.trim()).filter(s => s.length > 1);
    // Run export/mail actions LAST so the data (sort/filter) is ready first
    const isExport = (s: string) => /\b(export|download|send|mail|email|save\s+as)\b/i.test(s);
    return [...segs.filter(s => !isExport(s)), ...segs.filter(isExport)];
  }

  private runSingleIntent(input: string, mergeFilters = false): CommandResult {
    const t = input.toLowerCase().trim();

    // ── Help ────────────────────────────────────────────────────────────────
    if (/^(help|\?|commands?|what can you do|capabilities)$/i.test(t)) return this.buildHelp();

    // ── Reset ───────────────────────────────────────────────────────────────
    if (/^(reset|clear all|show all rows|restore|reload|start over)$/i.test(t)) {
      this.gridApi!.setFilterModel(null);
      this.dateFilters = [];
      this.gridApi!.applyColumnState({ defaultState: { sort: null } });
      this.setRowDataFn?.(this.allRows);
      this.gridApi!.setColumnsVisible(ALL_COL_IDS, true);
      this.setPaginationFn?.(true);
      this.gridApi!.setGridOption('paginationPageSize', 10);
      return this.ok('reset', `Grid reset — ${this.allRows.length} rows, all columns, no filters.`, [], 'Reset all state.');
    }

    // ── Clear filters ────────────────────────────────────────────────────────
    if (/clear.*(filter|search)|^(clear filters?|reset filters?|remove filters?)$/i.test(t)) {
      this.gridApi!.setFilterModel(null);
      this.dateFilters = [];
      this.gridApi!.onFilterChanged();
      this.setRowDataFn?.(this.allRows);
      return this.ok('clear-filters', `All filters cleared. ${this.allRows.length} rows visible.`, [], 'Clear filters.');
    }

    // ── Disable pagination / show all data ──────────────────────────────────
    if (/(?:show\s+all\s+(?:data|rows?|records?)|without\s+pag|disable\s+pag|no\s+pag|remove\s+pag|show\s+everything|all\s+rows?\s+without)/i.test(t)) {
      this.setRowDataFn?.(this.allRows);
      this.setPaginationFn?.(false);
      return this.ok('page-size', `All ${this.allRows.length} rows shown — pagination disabled.`, [], 'Disable pagination.');
    }

    // ── Enable pagination ────────────────────────────────────────────────────
    if (/enable\s+pag|with\s+pag|turn\s+on\s+pag/i.test(t)) {
      this.setPaginationFn?.(true);
      this.gridApi!.setGridOption('paginationPageSize', 10);
      return this.ok('page-size', 'Pagination enabled (10 per page).', [], 'Enable pagination.');
    }

    // ── Statistics ──────────────────────────────────────────────────────────
    const stats = this.tryStats(t);
    if (stats) return stats;

    // ── Show last / first N ─────────────────────────────────────────────────
    const topBot = this.tryTopBottom(t);
    if (topBot) return topBot;

    // ── Page size ────────────────────────────────────────────────────────────
    const pgSz = this.tryPageSize(t);
    if (pgSz) return pgSz;

    // ── Page navigate ────────────────────────────────────────────────────────
    const pgNav = this.tryPageNav(t);
    if (pgNav) return pgNav;

    // ── Sort ─────────────────────────────────────────────────────────────────
    const sortR = this.trySort(t);
    if (sortR) return sortR;

    // ── Export / Mail ────────────────────────────────────────────────────────
    const expR = this.tryExport(t, input);
    if (expR) return expR;

    // ── Selection ────────────────────────────────────────────────────────────
    const selR = this.trySelection(t);
    if (selR) return selR;

    // ── Multi-column visibility (FIXED — handles all the failing cases) ──────
    const colR = this.tryColVisibility(t);
    if (colR) return colR;

    // ── Auto-size ────────────────────────────────────────────────────────────
    if (/auto.?size|fit\s+col|resize\s+col/i.test(t)) {
      this.gridApi!.autoSizeAllColumns();
      return this.ok('auto-size', 'Columns auto-sized.', [], 'Auto-size.');
    }

    // ── Advanced NLU Filter ─────────────────────────────────────────────────
    const filterR = this.tryAdvancedFilter(t, mergeFilters);
    if (filterR) return filterR;

    return {
      success: false,
      message: `❌ Not understood: "${input.slice(0, 80)}"\nTip: Configure an LLM API in ⚙ Settings for smarter understanding. Type "help" for commands.`,
      parseInfo: this.pi('unknown', 0, [], 'Not recognized.'),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  COLUMN VISIBILITY — fully rewritten to handle multi-column & groups
  // ═══════════════════════════════════════════════════════════════════════════
  private tryColVisibility(t: string): CommandResult | null {
    // Show all columns
    if (/show\s+all\s+col|display\s+all\s+col|unhide\s+all|restore\s+col/i.test(t)) {
      this.gridApi!.setColumnsVisible(ALL_COL_IDS, true);
      return this.ok('show-all-cols', 'All columns visible.', [], 'Show all columns.');
    }

    const isHide = /^hide\b/i.test(t);
    const isShow = /^(?:show|unhide|reveal|display)\b/i.test(t) && !/^show\s+all\s+col/i.test(t);
    if (!isHide && !isShow) return null;

    const verb = isHide ? 'hide' : 'show';

    // "except" / "only" / "other than" logic → hide-all-except
    const hasExcept = /\bexcept\b|\bother\s+than\b|\bapart\s+from\b|\bonly\b/i.test(t);

    // Extract column list from text
    let colPart = t
      .replace(/^(hide|show|unhide|reveal|display)\s+/i, '')
      .replace(/\bcolumns?\b/gi, '')
      .replace(/\b(except|other\s+than|apart\s+from)\b.*/i, '')
      .replace(/\bonly\s+(sort\s+pairs?|target\s+date|submitted)/i, (_, g) => g)
      .trim();

    // Also try to extract the "except" part for "hide all except X"
    let exceptPart = '';
    const exceptMatch = t.match(/\b(?:except|other\s+than|apart\s+from)\s+(.+)$/i);
    if (exceptMatch) exceptPart = exceptMatch[1].trim();

    const cols = this.parseColList(hasExcept ? exceptPart : colPart);

    if (!cols.length) {
      // Could not parse columns — report it
      return { success: false, message: `❌ Couldn't identify columns in: "${t}". Try: "hide comments", "hide column user", or "hide all except sort pairs".`, parseInfo: this.pi('hide-col', 0.4, [], 'Column names not recognized.') };
    }

    if (hasExcept) {
      // Show only the 'except' columns, hide the rest
      const toHide = ALL_COL_IDS.filter(c => !cols.includes(c));
      this.gridApi!.setColumnsVisible(ALL_COL_IDS, true);
      this.gridApi!.setColumnsVisible(toHide, false);
      const kept = cols.map(c => this.lbl(c)).join(', ');
      return this.ok('hide-col', `Showing only: ${kept}  (${toHide.length} columns hidden)`, [], `Show only ${kept}.`);
    }

    this.gridApi!.setColumnsVisible(cols, verb === 'hide' ? false : true);
    const affected = cols.map(c => this.lbl(c)).join(', ');
    return this.ok(verb === 'hide' ? 'hide-col' : 'show-col', `${verb === 'hide' ? 'Hidden' : 'Shown'}: ${affected}`, [], `${verb} ${affected}.`);
  }

  /** Parse a comma/and/semicolon-separated list of column names or group names */
  private parseColList(text: string): string[] {
    // Split on commas, semicolons, " and ", " & "
    const parts = text.split(/[,;]|\s+and\s+|\s+&\s+|\s+or\s+/i);
    const out: string[] = [];
    for (const raw of parts) {
      const p = raw.trim().replace(/\bcolumns?\b/gi, '').replace(/\bthe\b/gi, '').trim();
      if (!p) continue;
      // Try direct column match
      const colId = this.findCol(p);
      if (colId) { out.push(colId); continue; }
      // Try group match
      const grpCols = this.findGroup(p);
      if (grpCols.length) { out.push(...grpCols); continue; }
    }
    return [...new Set(out)];
  }

  private findGroup(text: string): string[] {
    const t = text.toLowerCase().trim();
    for (const [key, cols] of Object.entries(COL_GROUPS)) {
      if (t === key || t.includes(key) || key.includes(t)) return cols;
    }
    return [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  OTHER RULE-BASED HANDLERS
  // ═══════════════════════════════════════════════════════════════════════════
  private tryStats(t: string): CommandResult | null {
    const isCount = /how many|^count\b|total\s+(rows?|records?)|number\s+of\s+rows/i.test(t);
    const isAvg   = /\baverage\b|\bavg\b|\bmean\b/i.test(t);
    const isSum   = /\bsum\b|\btotal\s+(number|pairs)/i.test(t);
    const isMax   = /\bmax(?:imum)?\b|\bhighest\b|\blargest\b|\bmost\b/i.test(t);
    const isMin   = /\bmin(?:imum)?\b|\blowest\b|\bsmallest\b|\bleast\b/i.test(t);
    const isDist  = /distribution|breakdown|group\s*by|per\s+user|by\s+submitter|who\s+submitted/i.test(t);
    if (!isCount && !isAvg && !isSum && !isMax && !isMin && !isDist) return null;

    const rows = this.getVisibleRows();
    if (isDist) {
      const dist: Record<string, number> = {};
      rows.forEach(r => { const k = r.submittedUser || '(Unknown)'; dist[k] = (dist[k] || 0) + 1; });
      const sorted = Object.entries(dist).sort((a, b) => b[1] - a[1]);
      const maxC = sorted[0]?.[1] || 1;
      const bars = sorted.map(([lbl, c]) => `  ${'█'.repeat(Math.round((c/maxC)*10)).padEnd(10)} ${String(c).padStart(3)} (${((c/rows.length)*100).toFixed(0).padStart(3)}%)  ${lbl}`).join('\n');
      return { success: true, message: `📊 Distribution by User (${rows.length} rows):\n${bars}`, parseInfo: this.pi('stats-distribution', 0.92, [{type:'column',label:'Group by',value:'User'}], 'Group by User.'), statResult: { type:'distribution', field:'submittedUser', value:rows.length, rows:rows.length, breakdown: sorted.map(([label,count])=>({label,count,pct:parseFloat(((count/rows.length)*100).toFixed(1))})) } };
    }
    if (isCount) {
      const byUser = t.match(/(?:by|from|submitted\s+by|for)\s+["']?([a-z][a-z\s]+?)["']?(?:\s|$)/i);
      if (byUser) { const kw=byUser[1].trim(); const m=rows.filter(r=>r.submittedUser.toLowerCase().includes(kw)); return {success:true,message:`📊 ${m.length} of ${rows.length} rows match user "${kw}".`,parseInfo:this.pi('stats-count',0.88,[{type:'value',label:'User',value:kw}],`Count where user~"${kw}".`),statResult:{type:'count',field:'submittedUser',value:m.length,rows:rows.length}}; }
      return {success:true,message:`📊 ${rows.length} row(s) visible  |  Total: ${this.allRows.length} rows.`,parseInfo:this.pi('stats-count',0.95,[{type:'number',label:'Visible',value:String(rows.length)}],'Count visible.'),statResult:{type:'count',value:rows.length,rows:rows.length}};
    }
    const nums = rows.map(r => r.number);
    if (isAvg) { const v=nums.reduce((a,b)=>a+b,0)/nums.length; return {success:true,message:`📊 Average "Number (#)": ${v.toFixed(2)}`,parseInfo:this.pi('stats-avg',0.92,[{type:'column',label:'Field',value:'Number (#)'}],'Avg.'),statResult:{type:'avg',field:'number',value:parseFloat(v.toFixed(2)),rows:rows.length}}; }
    if (isSum) { const v=nums.reduce((a,b)=>a+b,0); return {success:true,message:`📊 Sum of "Number (#)": ${v}`,parseInfo:this.pi('stats-sum',0.92,[{type:'column',label:'Field',value:'Number (#)'}],'Sum.'),statResult:{type:'sum',field:'number',value:v,rows:rows.length}}; }
    if (isMax) { const v=Math.max(...nums); const row=rows.find(r=>r.number===v); return {success:true,message:`📊 Max "Number (#)": ${v}  (ID: ${row?.id})`,parseInfo:this.pi('stats-max',0.92,[{type:'column',label:'Field',value:'Number (#)'}],'Max.'),statResult:{type:'max',field:'number',value:v,rows:rows.length}}; }
    if (isMin) { const v=Math.min(...nums); const row=rows.find(r=>r.number===v); return {success:true,message:`📊 Min "Number (#)": ${v}  (ID: ${row?.id})`,parseInfo:this.pi('stats-min',0.92,[{type:'column',label:'Field',value:'Number (#)'}],'Min.'),statResult:{type:'min',field:'number',value:v,rows:rows.length}}; }
    return null;
  }

  private tryTopBottom(t: string): CommandResult | null {
    const n = this.extractN(t);
    if (n === null) return null;
    const isLast  = /\b(last|bottom|recent|newest|latest)\b/i.test(t);
    const isFirst = /\b(first|top|oldest|earliest)\b/i.test(t);
    if (!isLast && !isFirst) return null;
    const ents: EntityItem[] = [{type:'number',label:'N',value:String(n)}];
    if (isLast) { this.setRowDataFn?.([...this.allRows].sort((a,b)=>b.id-a.id).slice(0,n)); this.gridApi!.setGridOption('paginationPageSize',Math.min(n,100)); return {success:true,message:`✅ Showing ${n} most recent rows.`,parseInfo:this.pi('show-last',0.95,ents,`Last ${n} rows.`)}; }
    this.setRowDataFn?.([...this.allRows].sort((a,b)=>a.id-b.id).slice(0,n)); this.gridApi!.setGridOption('paginationPageSize',Math.min(n,100));
    return {success:true,message:`✅ Showing ${n} earliest rows.`,parseInfo:this.pi('show-first',0.95,ents,`First ${n} rows.`)};
  }

  private tryPageSize(t: string): CommandResult | null {
    const m = t.match(/(?:show|set|display|use|view)?\s*(\w+)\s*(?:rows?|records?|entries?)?\s*(?:per\s*page|per\s*view|per\s*screen|on\s*each\s*page)/i);
    if (!m) return null;
    const n = this.parseNum(m[1]);
    if (!n || n < 1) return null;
    this.gridApi!.setGridOption('paginationPageSize', n);
    return {success:true,message:`✅ Page size → ${n} rows per page.`,parseInfo:this.pi('page-size',0.95,[{type:'number',label:'Size',value:String(n)}],`Page size ${n}.`)};
  }

  private tryPageNav(t: string): CommandResult | null {
    const m = t.match(/(?:go\s*to\s*|navigate\s+to\s*|jump\s+to\s*)?page\s+(\w+)/i) || t.match(/page\s*#?\s*(\w+)/i);
    if (!m) return null;
    const n = this.parseNum(m[1]);
    if (!n || n < 1) return null;
    this.gridApi!.paginationGoToPage(n - 1);
    return {success:true,message:`✅ Navigated to page ${n}.`,parseInfo:this.pi('page-goto',0.95,[{type:'number',label:'Page',value:String(n)}],`Go to page ${n}.`)};
  }

  private trySort(t: string): CommandResult | null {
    const m = t.match(/\b(?:sort|order|arrange|rank)\b\s*(?:the\s+(?:data|rows?|table)\s+)?(?:by\s+|on\s+|using\s+)?(.+)$/i);
    if (!m) return null;
    let colKw = m[1].trim();
    // Pull the direction out of the tail, then strip it from the column phrase
    let dir: 'asc'|'desc' = 'asc';
    const dirMatch = colKw.match(/\b(asc(?:ending)?|desc(?:ending)?|newest\s*first|oldest\s*first|a\s*to\s*z|z\s*to\s*a|high\w*\s*(?:to\s*low|first)?|low\w*\s*(?:to\s*high|first)?)\b/i);
    if (dirMatch) {
      if (/desc|newest|z\s*to\s*a|high/i.test(dirMatch[1])) dir = 'desc';
      colKw = colKw.replace(dirMatch[0], '').trim();
    }
    // Remove noise words so the full column phrase (e.g. "submitted by user") survives
    colKw = colKw.replace(/\b(?:column|field|the|in|order|value)\b/gi, '').replace(/\s+/g, ' ').trim();
    const colId = this.findCol(colKw);
    if (!colId) return {success:false,message:`❌ Sort: column "${colKw}" not found. Try: id, number, start, end, date, user, comments.`,parseInfo:this.pi('sort',0.5,[{type:'column',label:'Unknown',value:colKw}],'Column unknown.')};
    this.gridApi!.applyColumnState({state:[{colId,sort:dir}],defaultState:{sort:null}});
    return {success:true,message:`✅ Sorted by "${this.lbl(colId)}" ${dir==='asc'?'ascending ↑':'descending ↓'}`,parseInfo:this.pi('sort',0.95,[{type:'column',label:'Column',value:this.lbl(colId)},{type:'direction',label:'Direction',value:dir}],`Sort ${dir}.`)};
  }

  private tryExport(t: string, raw: string): CommandResult | null {
    const mailM = raw.match(/(?:send|share|email|mail)\s+(?:to\s+)?(?:mail|email|me)?\s*([\w.+%-]+@[\w.-]+\.[a-z]{2,})?/i);
    if (mailM && /mail|email|send|share/i.test(t)) {
      const to = mailM[1]||'';
      return {success:true,message:`✅ CSV exported. Mail client opened${to?' to '+to:''}.`,action:'send-mail',mailTo:to,parseInfo:this.pi('send-mail',0.92,to?[{type:'email',label:'To',value:to}]:[],`Email${to?' to '+to:''}.`)};
    }
    if (/export|download|save\s+as|extract|generate\s+(csv|file|report)/i.test(t)||/\bcsv\b|\bspreadsheet\b|\bexcel\b|\bxlsx\b/i.test(t)) {
      return {success:true,message:'✅ Exporting current view as CSV...',action:'export-csv',parseInfo:this.pi('export-csv',0.95,[{type:'value',label:'Format',value:/excel|xlsx/i.test(t)?'Excel (CSV)':'CSV'}],'Export CSV.')};
    }
    return null;
  }

  private trySelection(t: string): CommandResult | null {
    if (/\bselect\b/i.test(t) && !/deselect|unselect|uncheck/i.test(t)) { this.gridApi!.selectAll(); const n=this.gridApi!.getSelectedRows().length; return {success:true,message:`✅ ${n} rows selected.`,parseInfo:this.pi('select-all',1,[{type:'number',label:'Count',value:String(n)}],'Select all.')}; }
    if (/deselect|unselect|uncheck|clear\s+selection|remove\s+selection/i.test(t)) { this.gridApi!.deselectAll(); return {success:true,message:'✅ All rows deselected.',parseInfo:this.pi('deselect-all',1,[],'Deselect.')}; }
    return null;
  }

  private tryAdvancedFilter(t: string, merge = false): CommandResult | null {
    const hasIntent = /\b(filter|show|find|get|list|display|where|who|which|whose|having|submitted|records?|rows?|entries?|look\s+for|search|give\s+me)\b/i.test(t);
    if (!hasIntent) return null;
    const conditions = this.extractConditions(t);
    if (!conditions.length) return null;
    // Date conditions run through the external filter; everything else via the column filter model.
    const gridConds = conditions.filter(c => !c.isDate);
    const dateConds = conditions.filter(c => c.isDate);
    // When merging (chained filters), start from the current model & date filters so they AND together.
    const current = merge ? this.gridApi!.getFilterModel() : null;
    const model: Record<string, unknown> = current ? { ...current } : {};
    const descs: string[] = [];
    for (const c of gridConds) {
      const entry = this.buildFilterEntry(c);
      model[c.field] = model[c.field]
        ? { filterType: c.filterType, operator: 'AND', condition1: model[c.field], condition2: entry }
        : entry;
      descs.push(this.descCond(c));
    }
    const newDateFilters: DateCond[] = dateConds.map(c => ({ cols: c.dateCols!, op: c.dateOp!, from: c.dateFrom ?? null, to: c.dateTo ?? null }));
    this.dateFilters = merge ? [...this.dateFilters, ...newDateFilters] : newDateFilters;
    for (const c of dateConds) descs.push(this.descCond(c));
    this.gridApi!.setFilterModel(Object.keys(model).length ? model : null);
    this.gridApi!.onFilterChanged();
    const vis = this.gridApi!.getDisplayedRowCount();
    const ents: EntityItem[] = conditions.flatMap(c=>[{type:'column' as const,label:'Column',value:this.lbl(c.field)},{type:'operator' as const,label:'Op',value:c.agOp},...(c.value!==null?[{type:'value' as const,label:'Value',value:String(c.value)}]:[])]);
    return {success:true,message:`✅ ${vis} row(s) match:\n  ${descs.join('\n  ')}`,parseInfo:this.pi('filter',Math.min(0.65+conditions.length*0.1,0.95),ents,`Filter: ${descs.join('; ')}`)};
  }

  private extractConditions(text: string): CondEx[] {
    // Protect the "and" inside "between X and Y" so the range isn't split into two conditions.
    const SENTINEL = '\u0001';
    const guarded = text.replace(/\bbetween\b.+?\band\b/gi, seg => seg.replace(/\band\b/i, SENTINEL));
    // Split conditions on sentence separators (". " / "; ") AND connective words ("and", "plus"…).
    const parts = guarded
      .split(/\s*[.;]\s+|\s+(?:and|also|additionally|plus|as\s+well\s+as)\s+/i)
      .map(p => p.replace(new RegExp(SENTINEL, 'g'), 'and'));
    const result = parts.map(p => this.parseOneCond(p.trim())).filter((c): c is CondEx => c !== null);
    if (!result.length) { const c = this.parseOneCond(text.trim()); return c ? [c] : []; }
    return result;
  }

  private parseOneCond(text: string): CondEx | null {
    let t = text.replace(/^(?:filter|show|find|get|list|display)\s+(?:rows?\s+)?(?:where\s+|with\s+)?/i,'').replace(/^(?:rows?|records?|entries?)\s+(?:where|with|having|that\s+have)\s+/i,'').trim();
    for (const {agOp,keywords} of OPS) {
      for (const kw of [...keywords].sort((a,b)=>b.length-a.length)) {
        const kwP = kw.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
        const m = t.match(new RegExp(`^(.+?)\\s+${kwP}(?:\\s+(.+))?$`,'i'));
        if (!m) continue;
        // ── DATE columns: parse natural-language dates & route to external filter ──
        const dTgt = this.resolveDateTarget(m[1].trim());
        if (dTgt && ['inRange','greaterThan','greaterThanOrEqual','lessThan','lessThanOrEqual','equals'].includes(agOp)) {
          // Return the parsed date condition, or null (drop the segment) so we
          // never fall through to a bogus text "contains" that matches nothing.
          return this.buildDateCond(dTgt.cols, agOp, (m[2]||'').trim());
        }
        const colId = this.findCol(m[1].trim());
        if (!colId) continue;
        const col = COLS.find(c=>c.id===colId)!;
        const rawVal = (m[2]||'').trim().replace(/^['"]|['"]$/g,'');
        if (agOp==='blank'||agOp==='notBlank') return {field:colId,filterType:col.filterType,agOp,value:null};
        if (agOp==='inRange') { const rm=rawVal.match(/(\d[\d.]*)\s+(?:and|to|-)\s+(\d[\d.]*)/i); if(rm) return {field:colId,filterType:col.filterType,agOp,value:null,from:parseFloat(rm[1]),to:parseFloat(rm[2])}; continue; }
        const rawFull = (m[2]||'').trim();
        if (!rawFull) continue;
        // OR of multiple values on one column: "'schema' or 'test'", "a / b", "x, y"
        const orVals = this.splitOrValues(rawFull);
        if (orVals.length > 1) {
          const vals: (string|number)[] = orVals.map(v => col.filterType==='number' ? (parseFloat(v)||v) : v);
          return {field:colId,filterType:col.filterType,agOp,value:null,values:vals};
        }
        if (!rawVal) continue;
        const single = rawVal.replace(/^(?:the|a|an)\s+/i, '').trim();
        const value: string|number = col.filterType==='number'?(parseFloat(single)||single):single;
        return {field:colId,filterType:col.filterType,agOp,value};
      }
    }
    const impl = t.match(/^(.{2,30}?)\s+["']?([A-Za-z0-9][\w\s@.-]{1,60})["']?$/);
    if (impl) { const colId=this.findCol(impl[1].trim()); if(colId){const col=COLS.find(c=>c.id===colId)!;return {field:colId,filterType:col.filterType,agOp:'contains',value:impl[2].trim()};} }
    const nm = t.match(/(?:^|(?:by|from|for)\s+)([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)/);
    if (nm) return {field:'submittedUser',filterType:'text',agOp:'contains',value:nm[1].trim()};
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════════════════════════════════
  private findCol(keyword: string): string | null {
    const kw = keyword.toLowerCase().trim().replace(/^(?:the|a|an)\s+/i, '').trim();
    if (!kw) return null;
    // 1) Exact id / alias match
    for (const col of COLS) { if (col.id===kw || col.aliases.includes(kw)) return col.id; }
    // 2) Best fuzzy match — prefer the LONGEST matching alias so
    //    "submitted by user" → submittedUser (alias "submitted by") beats
    //    submittedDate (alias "submitted").
    let best: { id: string; len: number } | null = null;
    for (const col of COLS) {
      for (const a of col.aliases) {
        if (kw.includes(a) || a.includes(kw)) {
          if (!best || a.length > best.len) best = { id: col.id, len: a.length };
        }
      }
    }
    return best?.id ?? null;
  }
  private lbl(id: string): string { return COLS.find(c=>c.id===id)?.label??id; }
  /** Split an OR value list like "'schema' or 'test'" | "a / b" | "x, y" into clean values. */
  private splitOrValues(text: string): string[] {
    return text.split(/\s+or\s+|\s*\/\s*|\s*,\s*/i)
      .map(s => s.trim().replace(/^['"]|['"]$/g,'').replace(/^(?:the|a|an)\s+/i,'').trim())
      .filter(s => s.length > 0);
  }
  /** Build an AG Grid filter model entry for one condition (handles OR multi-value). */
  private buildFilterEntry(c: CondEx): Record<string, unknown> {
    if (c.values && c.values.length > 1) {
      return {
        filterType: c.filterType,
        operator: 'OR',
        conditions: c.values.map(v => ({ filterType: c.filterType, type: c.agOp, filter: v })),
      };
    }
    const af: Record<string, unknown> = { filterType: c.filterType, type: c.agOp };
    if (c.agOp !== 'blank' && c.agOp !== 'notBlank') {
      if (c.agOp === 'inRange') { af['filter'] = c.from; af['filterTo'] = c.to; }
      else af['filter'] = c.value;
    }
    return af;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DATE FILTERING (natural language → external filter)
  // ═══════════════════════════════════════════════════════════════════════════
  /** Map a column phrase to date column(s). Groups like "target date range" span both target dates. */
  private resolveDateTarget(phrase: string): { cols: string[] } | null {
    const p = phrase.toLowerCase().trim()
      .replace(/^(?:the|a|an)\s+/i, '')
      .replace(/\b(?:column|field|value)\b/g, '')
      .trim();
    if (!p) return null;
    // 1) exact alias match (range groups are listed before single date fields)
    for (const t of DATE_TARGETS) { if (t.cols.length && t.aliases.includes(p)) return { cols: t.cols }; }
    // 2) best fuzzy match — longest alias that contains / is contained by the phrase
    let best: { cols: string[]; len: number } | null = null;
    for (const t of DATE_TARGETS) {
      if (!t.cols.length) continue;
      for (const a of t.aliases) {
        if ((p.includes(a) || a.includes(p)) && (!best || a.length > best.len)) best = { cols: t.cols, len: a.length };
      }
    }
    return best ? { cols: best.cols } : null;
  }

  /** Build a date CondEx from an operator + raw value; null if the value has no parseable date. */
  private buildDateCond(cols: string[], agOp: string, rawValue: string): CondEx | null {
    if (agOp === 'inRange') {
      const rng = this.parseDateRange(rawValue);
      if (!rng) return null;
      return { field: cols[0], filterType: 'text', agOp, value: null, isDate: true, dateCols: cols, dateOp: 'inRange', dateFrom: rng.from, dateTo: rng.to };
    }
    const d = this.parseNaturalDate(rawValue);
    if (!d) return null;
    const dop: 'after' | 'before' | 'on' = agOp === 'equals' ? 'on' : (agOp.startsWith('greater') ? 'after' : 'before');
    return { field: cols[0], filterType: 'text', agOp, value: null, isDate: true, dateCols: cols, dateOp: dop, dateFrom: dop === 'before' ? null : d.ms, dateTo: dop === 'after' ? null : d.ms };
  }

  /** Parse a single natural-language date → epoch ms (UTC). Handles MM/DD/YYYY, YYYY-MM-DD, "june 5[th] [2026]", "5 june [2026]". */
  private parseNaturalDate(raw: string): { ms: number; hasYear: boolean } | null {
    const s = raw.toLowerCase().trim().replace(/(\d+)(?:st|nd|rd|th)\b/g, '$1').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);              // MM/DD/YYYY
    if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return { ms: Date.UTC(y, +m[1] - 1, +m[2]), hasYear: true }; }
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);                      // YYYY-MM-DD
    if (m) return { ms: Date.UTC(+m[1], +m[2] - 1, +m[3]), hasYear: true };
    m = s.match(/^([a-z]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/);             // month day [year]
    if (m && AiCommandService.MONTHS[m[1]] !== undefined) {
      const hasY = !!m[3]; return { ms: Date.UTC(hasY ? +m[3] : new Date().getFullYear(), AiCommandService.MONTHS[m[1]], +m[2]), hasYear: hasY };
    }
    m = s.match(/^(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?$/);             // day month [year]
    if (m && AiCommandService.MONTHS[m[2]] !== undefined) {
      const hasY = !!m[3]; return { ms: Date.UTC(hasY ? +m[3] : new Date().getFullYear(), AiCommandService.MONTHS[m[2]], +m[1]), hasYear: hasY };
    }
    return null;
  }

  /** Parse "june 5 to june 30th 2026" (or "X and Y", "X - Y") → {from, to} ms. Shares a year across bounds when only one carries it. */
  private parseDateRange(raw: string): { from: number; to: number } | null {
    const parts = raw.split(/\s+(?:to|and|through|thru|till|until|-|–|—)\s+/i).map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) return null;
    const lo = parts[0], hi = parts[parts.length - 1];
    const yr = (raw.match(/\b(\d{4})\b/) || [])[1];
    let a = this.parseNaturalDate(lo), b = this.parseNaturalDate(hi);
    if (a && !a.hasYear && yr) a = this.parseNaturalDate(`${lo} ${yr}`);   // borrow the shared year
    if (b && !b.hasYear && yr) b = this.parseNaturalDate(`${hi} ${yr}`);
    if (!a || !b) return null;
    return { from: Math.min(a.ms, b.ms), to: Math.max(a.ms, b.ms) };
  }

  /** Read a row's date column (strips any time suffix) → epoch ms. */
  private rowDateMs(row: SortPairRow, col: string): number | null {
    const raw = (row as unknown as Record<string, string>)[col];
    if (!raw) return null;
    const d = this.parseNaturalDate(raw.split(' ')[0]);
    return d ? d.ms : null;
  }

  /** External-filter predicate: a row passes every active date filter (AND). */
  private passesDateFilters(row: SortPairRow): boolean {
    for (const dc of this.dateFilters) {
      const vals = dc.cols.map(c => this.rowDateMs(row, c)).filter((v): v is number => v !== null);
      if (!vals.length) return false;
      const lo = Math.min(...vals), hi = Math.max(...vals);
      if (dc.op === 'inRange') { if (!(hi >= dc.from! && lo <= dc.to!)) return false; }          // interval overlap
      else if (dc.op === 'after') { if (!(hi >= dc.from!)) return false; }
      else if (dc.op === 'before') { if (!(lo <= dc.to!)) return false; }
      else if (dc.op === 'on') { if (!vals.some(v => v === dc.from)) return false; }
    }
    return true;
  }

  private fmtDate(ms: number): string {
    const d = new Date(ms);
    return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
  }

  private extractN(text: string): number | null { const dm=text.match(/\b(\d+)\b/); if(dm) return parseInt(dm[1],10); for(const [w,n] of Object.entries(NUMBER_WORDS)){if(text.includes(w))return n;} return null; }
  private parseNum(token: string): number | null { const n=parseInt(token,10); return isNaN(n)?(NUMBER_WORDS[token.toLowerCase()]??null):n; }
  private getVisibleRows(): SortPairRow[] { const rows: SortPairRow[]=[]; this.gridApi?.forEachNodeAfterFilter(n=>{if(n.data)rows.push(n.data);}); return rows.length?rows:[...this.allRows]; }
  private descCond(c: CondEx): string { const l=this.lbl(c.field); if(c.isDate) return this.descDateCond(c); if(c.agOp==='blank') return `${l} is empty`; if(c.agOp==='notBlank') return `${l} is not empty`; if(c.agOp==='inRange') return `${l} between ${c.from} and ${c.to}`; if(c.values && c.values.length) return `${l} ${c.agOp} (${c.values.map(v=>`"${v}"`).join(' OR ')})`; return `${l} ${c.agOp} "${c.value}"`; }
  private descDateCond(c: CondEx): string {
    const l = (c.dateCols?.length ?? 0) > 1 ? 'Target date' : this.lbl(c.dateCols![0]);
    if (c.dateOp === 'inRange') return `${l} between ${this.fmtDate(c.dateFrom!)} and ${this.fmtDate(c.dateTo!)}`;
    if (c.dateOp === 'after')   return `${l} on/after ${this.fmtDate(c.dateFrom!)}`;
    if (c.dateOp === 'before')  return `${l} on/before ${this.fmtDate(c.dateTo!)}`;
    return `${l} on ${this.fmtDate(c.dateFrom!)}`;
  }
  private ok(intent: string, msg: string, ents: EntityItem[], interp = msg): CommandResult { return {success:true,message:`✅ ${msg}`,parseInfo:this.pi(intent,1,ents,interp)}; }
  private pi(intent: string, confidence: number, entities: EntityItem[], interpretation: string): ParseInfo { return {intent,intentLabel:INTENT_LABELS[intent]??intent,confidence,entities,interpretation}; }

  private buildHelp(): CommandResult {
    const llmNote = this.llm.isConfigured()
      ? '🤖 LLM configured — free-form natural language supported!'
      : '⚠ No LLM configured — using rule-based NLU. Add API key in ⚙ Settings for full AI.';
    return {
      success: true,
      message: `${llmNote}

📋 ROW DISPLAY
  show last 10 rows | top 5 | first 20 | bottom 3

📄 PAGINATION
  show 20 rows per page | go to page 3
  show all data without pagination | enable pagination

↕ SORTING
  sort by date desc | order by user a to z | sort by number highest first

🔍 FILTERING  (multi-condition supported)
  filter user contains Vignesh
  show rows where number > 5
  comments is not empty
  show rows where number equals 4 and user contains Sowmiya
  filter id between 11710 and 11720
  submitted by Oscar          ← smart name lookup

👁 COLUMNS  (groups and multi-column supported)
  hide column user
  hide column user, submitted by, target date range start and end
  hide column except sort pairs
  show all columns

📊 STATISTICS
  how many rows | distribution by user | average sort pair number

📦 EXPORT
  export csv | send to mail user@example.com

⛓ CHAIN (use ";")
  filter user contains Vignesh; sort by date desc; export csv

🔄 RESET  →  clear filters | reset | restore`,
      parseInfo: this.pi('help', 1, [], 'Help.'),
    };
  }
}

