// ═══════════════════════════════════════════════════════════════════════════
//  GRID SCHEMA — the single source of truth for the whole app.
//
//  The grid columns, the rule-based NLU engine, the date-filter logic, the LLM
//  system prompt, and the CSV/data layer are ALL derived from this one config.
//  To add / rename / retype a column, edit it HERE and everything follows.
// ═══════════════════════════════════════════════════════════════════════════

/** How a field behaves for filtering & parsing. `date` is stored as text but understood as a calendar date. */
export type ColKind = 'number' | 'text' | 'date';

export interface FieldSchema {
  id: string;                 // data key (e.g. 'submittedUser')
  label: string;              // human label used by the NLU / messages
  header: string;             // short grid column header
  kind: ColKind;              // number | text | date
  aliases: string[];          // natural-language names the NLU should recognize
  group?: string;             // group id this field belongs to (optional)
  width?: number;
  minWidth?: number;
  flex?: number;
  sort?: 'asc' | 'desc';      // initial sort
  tooltip?: boolean;          // show value as cell tooltip
}

export interface GroupSchema {
  id: string;                 // group id (e.g. 'targetDateRange')
  header: string;             // grid group header
  fields: string[];           // ordered field ids
  aliases: string[];          // natural-language names for the whole group
  isDateRange?: boolean;      // true → group represents a start/end date window
}

export interface GridSchema {
  fields: FieldSchema[];
  groups: GroupSchema[];
}

// ─── The concrete schema for this dataset ────────────────────────────────────
export const GRID_SCHEMA: GridSchema = {
  groups: [
    { id: 'sortPairs',       header: 'Sort Pairs',        fields: ['id', 'number'],
      aliases: ['sort pairs', 'sort pair', 'pairs'] },
    { id: 'targetDateRange', header: 'Target Date Range',  fields: ['targetDateStart', 'targetDateEnd'],
      aliases: ['target date range', 'target date', 'date range', 'start and end', 'start date and end', 'target'], isDateRange: true },
    { id: 'submittedBy',     header: 'Submitted By',       fields: ['submittedDate', 'submittedUser'],
      aliases: ['submitted by', 'submission'] },
  ],
  fields: [
    { id: 'id',              label: 'ID',             header: 'ID',    kind: 'number', group: 'sortPairs',       width: 110,
      aliases: ['id', 'sort pair id', 'pair id', 'record id', 'identifier'] },
    { id: 'number',          label: 'Number (#)',     header: '#',     kind: 'number', group: 'sortPairs',       width: 80,
      aliases: ['number', 'num', '#', 'pair count', 'sort pairs count', 'sort pair number', 'quantity', 'amount'] },
    { id: 'targetDateStart', label: 'Start Date',     header: 'Start', kind: 'date',   group: 'targetDateRange', width: 130,
      aliases: ['start', 'start date', 'begin date', 'beginning', 'from date', 'target start', 'target date start'] },
    { id: 'targetDateEnd',   label: 'End Date',       header: 'End',   kind: 'date',   group: 'targetDateRange', width: 130,
      aliases: ['end', 'end date', 'finish date', 'finish', 'due date', 'due', 'until', 'target end', 'target date end'] },
    { id: 'submittedDate',   label: 'Submitted Date', header: 'Date',  kind: 'date',   group: 'submittedBy',     width: 170, sort: 'desc',
      aliases: ['date', 'submitted date', 'submitted on', 'submission date', 'when', 'created on', 'submitted', 'created'] },
    { id: 'submittedUser',   label: 'User',           header: 'User',  kind: 'text',   group: 'submittedBy',     width: 220,
      aliases: ['user', 'submitted by', 'who', 'author', 'submitter', 'person', 'employee', 'name', 'owner', 'submitteduser'] },
    { id: 'comments',        label: 'Comments',       header: 'Comments', kind: 'text', flex: 1, minWidth: 200, tooltip: true,
      aliases: ['comment', 'comments', 'remarks', 'note', 'notes', 'description', 'remark', 'feedback'] },
  ],
};

// ─── Derived helpers (computed once from the schema) ─────────────────────────
export const ALL_FIELD_IDS: string[] = GRID_SCHEMA.fields.map(f => f.id);
export const DATE_FIELD_IDS: string[] = GRID_SCHEMA.fields.filter(f => f.kind === 'date').map(f => f.id);

const FIELD_BY_ID = new Map(GRID_SCHEMA.fields.map(f => [f.id, f]));
export function fieldById(id: string): FieldSchema | undefined { return FIELD_BY_ID.get(id); }

/** AG Grid / NLU filter type — dates are stored as text, so they filter as text unless handled specially. */
export function filterTypeOf(kind: ColKind): 'text' | 'number' { return kind === 'number' ? 'number' : 'text'; }
