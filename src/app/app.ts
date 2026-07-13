import { Component, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AgGridAngular } from 'ag-grid-angular';
import {
  AllCommunityModule,
  ModuleRegistry,
  ColDef,
  ColGroupDef,
  GridApi,
  GridReadyEvent,
  PaginationChangedEvent,
  GetContextMenuItemsParams,
  MenuItemDef,
  DefaultMenuItem,
} from 'ag-grid-community';
import { DataService, SortPairRow } from './services/data.service';
import { AiCommandService, CommandResult, ParseInfo, StatResult } from './services/ai-command.service';
import { AiLlmService, LlmConfig, LLM_PRESETS } from './services/ai-llm.service';

ModuleRegistry.registerModules([AllCommunityModule]);

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, AgGridAngular],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  // ── Grid config (columns are built from the shared schema in ngOnInit) ───────
  columnDefs: (ColDef | ColGroupDef)[] = [];

  defaultColDef: ColDef = {
    resizable: true,
    sortable: true,
    filter: true,
    floatingFilter: true,
    suppressHeaderMenuButton: false,
  };

  rowData: SortPairRow[] = [];
  private allRows: SortPairRow[] = [];
  private gridApi!: GridApi<SortPairRow>;

  pagination = true;
  paginationPageSize = 10;
  paginationPageSizeSelector = [5, 10, 20, 50, 100];
  rowSelection: 'single' | 'multiple' = 'multiple';

  // Status bar info
  totalRows = 0;
  selectedRows = 0;
  currentPage = 1;
  totalPages = 1;

  // AI Command panel
  aiInput = '';
  aiMessages: {
    text: string;
    success: boolean;
    time: string;
    parseInfo?: ParseInfo;
    statResult?: StatResult;
    expanded: boolean;
  }[] = [];
  showHints = false;
  isProcessing = false;
  lastParseInfo: ParseInfo | null = null;

  readonly hints = [
    'show last 10 rows',
    'show first 5 rows',
    'show 20 rows per page',
    'sort by date desc',
    'sort by user asc',
    'filter user contains Vignesh',
    'show rows where number > 5',
    'filter id between 11710 and 11720',
    'show rows where comments is not empty',
    'distribution by user',
    'how many rows',
    'average sort pair number',
    'count records by Vignesh',
    'select all',
    'hide column comments',
    'show all columns',
    'export csv',
    'send to mail user@example.com',
    'filter user contains Vignesh; sort by date desc',
    'clear filters',
    'reset',
    'help',
  ];

  // ── LLM Settings ─────────────────────────────────────────────────────────────
  showSettings = false;
  llmConfig: LlmConfig = { provider: 'groq', apiKey: '', model: 'llama-3.1-8b-instant', baseUrl: 'https://api.groq.com/openai/v1' };
  llmStatus: 'unconfigured' | 'testing' | 'connected' | 'error' = 'unconfigured';
  llmStatusMsg = '';
  readonly llmPresets = LLM_PRESETS;
  readonly llmProviders = ['groq', 'openai', 'gemini', 'grok', 'ollama', 'custom'] as const;

  constructor(private dataSvc: DataService, private aiSvc: AiCommandService, private llmSvc: AiLlmService) {}

  ngOnInit(): void {
    this.columnDefs = this.dataSvc.getColumnDefs();
    this.allRows = this.dataSvc.getAll();
    this.rowData = [...this.allRows];
    const cfg = this.llmSvc.loadConfig();
    if (cfg) {
      this.llmConfig = { ...cfg };
      this.llmStatus = 'connected';
      this.llmStatusMsg = `${cfg.provider} / ${cfg.model}`;
    }
  }

  onGridReady(event: GridReadyEvent<SortPairRow>): void {
    this.gridApi = event.api;
    this.aiSvc.initialize(
      this.gridApi,
      this.allRows,
      (rows: SortPairRow[]) => { this.rowData = rows; },
      (enabled: boolean) => { this.pagination = enabled; },
    );
    this.updateStats();
  }

  onPaginationChanged(_e: PaginationChangedEvent): void {
    if (this.gridApi) {
      this.currentPage = this.gridApi.paginationGetCurrentPage() + 1;
      this.totalPages = this.gridApi.paginationGetTotalPages();
    }
  }

  onSelectionChanged(): void {
    this.selectedRows = this.gridApi?.getSelectedRows().length ?? 0;
  }

  onFilterChanged(): void {
    this.updateStats();
  }

  private updateStats(): void {
    if (!this.gridApi) return;
    this.totalRows = this.gridApi.getDisplayedRowCount();
    this.currentPage = this.gridApi.paginationGetCurrentPage() + 1;
    this.totalPages = this.gridApi.paginationGetTotalPages();
  }

  // ── Context menu ─────────────────────────────────────────────────────────────
  getContextMenuItems(params: GetContextMenuItemsParams): (DefaultMenuItem | MenuItemDef)[] {
    return [
      'copy',
      'copyWithHeaders',
      'separator',
      {
        name: 'Export CSV',
        icon: '<span class="ctx-icon">📄</span>',
        action: () => this.exportCsv(),
      },
      {
        name: 'Send to Mail',
        icon: '<span class="ctx-icon">✉️</span>',
        action: () => this.triggerSendMail(''),
      },
      'separator',
      'autoSizeAll',
    ];
  }

  // ── Toolbar actions ──────────────────────────────────────────────────────────
  importCsv(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result as string;
        const parsed = this.parseCsv(text);
        if (parsed.length) {
          this.allRows = parsed;
          this.rowData = [...parsed];
          this.aiSvc.initialize(this.gridApi, this.allRows, (rows: SortPairRow[]) => { this.rowData = rows; }, (enabled: boolean) => { this.pagination = enabled; });
          this.addAiMessage('✅ CSV imported: ' + parsed.length + ' rows loaded.', true);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }

  exportCsv(): void {
    this.gridApi?.exportDataAsCsv({
      fileName: `sort-pairs-${new Date().toISOString().slice(0, 10)}.csv`,
    });
  }

  clearFilters(): void {
    this.gridApi?.setFilterModel(null);
    this.rowData = [...this.allRows];
  }

  refresh(): void {
    this.rowData = [...this.allRows];
    this.gridApi?.setFilterModel(null);
    this.gridApi?.applyColumnState({ defaultState: { sort: null } });
    this.gridApi?.setGridOption('paginationPageSize', 10);
    this.addAiMessage('✅ Grid refreshed.', true);
  }

  createSortPair(): void {
    const maxId = Math.max(...this.allRows.map(r => r.id), 0);
    const newRow: SortPairRow = {
      id: maxId + 1,
      number: 1,
      targetDateStart: '',
      targetDateEnd: '',
      submittedDate: new Date().toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
      submittedUser: '',
      comments: '',
    };
    this.allRows = [newRow, ...this.allRows];
    this.rowData = [...this.allRows];
    this.addAiMessage(`✅ New Sort Pair created (ID: ${newRow.id}).`, true);
  }

  // ── AI Command panel ─────────────────────────────────────────────────────────
  processAiCommand(): void {
    const input = this.aiInput.trim();
    if (!input) return;
    this.isProcessing = true;
    this.aiInput = '';
    this.showHints = false;

    this.aiSvc.process(input).then(result => {
      this.addAiMessage(result.message, result.success, result.parseInfo, result.statResult);
      this.lastParseInfo = result.parseInfo ?? null;
      if (result.action === 'export-csv') {
        this.exportCsv();
      } else if (result.action === 'send-mail') {
        this.exportCsv();
        this.triggerSendMail(result.mailTo || '');
      }
      this.updateStats();
      this.isProcessing = false;
    }).catch(err => {
      this.addAiMessage(`❌ Error: ${(err as Error).message}`, false);
      this.isProcessing = false;
    });
  }

  // ── LLM Settings panel ───────────────────────────────────────────────────────
  openSettings(): void {
    const cfg = this.llmSvc.getConfig();
    this.llmConfig = cfg ? { ...cfg } : { provider: 'groq', apiKey: '', model: 'llama-3.1-8b-instant', baseUrl: 'https://api.groq.com/openai/v1' };
    this.showSettings = true;
  }

  closeSettings(): void {
    this.showSettings = false;
  }

  onProviderChange(): void {
    const p = this.llmPresets[this.llmConfig.provider];
    if (p) {
      this.llmConfig.baseUrl = p.baseUrl;
      this.llmConfig.model = p.model;
    }
    // Ollama runs locally and needs no real key — supply a placeholder so the
    // "configured" checks pass without asking the user for a key.
    if (this.llmConfig.provider === 'ollama' && !this.llmConfig.apiKey) {
      this.llmConfig.apiKey = 'ollama';
    }
  }

  saveLlmConfig(): void {
    if (!this.llmConfig.apiKey || !this.llmConfig.baseUrl || !this.llmConfig.model) return;
    this.llmSvc.setConfig(this.llmConfig);
    this.llmStatus = 'connected';
    this.llmStatusMsg = `${this.llmConfig.provider} / ${this.llmConfig.model}`;
    this.showSettings = false;
    this.addAiMessage(`✅ LLM configured: ${this.llmConfig.provider} (${this.llmConfig.model}). Free-form AI is active!`, true);
  }

  async testLlmConnection(): Promise<void> {
    if (!this.llmConfig.apiKey || !this.llmConfig.baseUrl) { this.llmStatus = 'error'; this.llmStatusMsg = 'Fill in API key and URL first.'; return; }
    this.llmSvc.setConfig(this.llmConfig);
    this.llmStatus = 'testing';
    this.llmStatusMsg = 'Testing connection...';
    try {
      const msg = await this.llmSvc.testConnection(this.allRows);
      this.llmStatus = 'connected';
      this.llmStatusMsg = msg;
    } catch (e) {
      this.llmStatus = 'error';
      this.llmStatusMsg = (e as Error).message;
    }
  }

  clearLlmConfig(): void {
    this.llmSvc.clearConfig();
    this.llmStatus = 'unconfigured';
    this.llmStatusMsg = '';
    this.llmConfig = { provider: 'groq', apiKey: '', model: 'llama-3.1-8b-instant', baseUrl: 'https://api.groq.com/openai/v1' };
    this.addAiMessage('ℹ LLM disconnected. Using rule-based NLU.', true);
  }

  onAiKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.processAiCommand();
    }
  }

  applyHint(hint: string): void {
    this.aiInput = hint;
    this.showHints = false;
    this.processAiCommand();
  }

  clearAiHistory(): void {
    this.aiMessages = [];
  }

  private addAiMessage(text: string, success: boolean, parseInfo?: ParseInfo, statResult?: StatResult): void {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    this.aiMessages.unshift({ text, success, time, parseInfo, statResult, expanded: false });
    if (this.aiMessages.length > 50) this.aiMessages.pop();
  }

  toggleExpand(msg: { expanded: boolean }): void {
    msg.expanded = !msg.expanded;
  }

  confidencePct(c: number): string { return Math.round(c * 100) + '%'; }
  confidenceClass(c: number): string { return c >= 0.8 ? 'high' : c >= 0.5 ? 'medium' : 'low'; }

  private triggerSendMail(to: string): void {
    const subject = encodeURIComponent('Sort Pairs Export');
    const body = encodeURIComponent('Please find the attached Sort Pairs CSV export.\n\nGenerated on ' + new Date().toLocaleString());
    window.location.href = `mailto:${to}?subject=${subject}&body=${body}`;
  }

  private parseCsv(text: string): SortPairRow[] {
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 2) return [];
    return lines.slice(1).map((line, i) => {
      const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
      return {
        id: parseInt(cols[0], 10) || (11800 + i),
        number: parseInt(cols[1], 10) || 1,
        targetDateStart: cols[2] || '',
        targetDateEnd: cols[3] || '',
        submittedDate: cols[4] || '',
        submittedUser: cols[5] || '',
        comments: cols[6] || '',
      };
    }).filter(r => !isNaN(r.id));
  }
}

