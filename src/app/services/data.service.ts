import { Injectable } from '@angular/core';
import { ColDef, ColGroupDef } from 'ag-grid-community';
import { GRID_SCHEMA, filterTypeOf, ColKind } from './grid-schema';

export interface SortPairRow {
  id: number;
  number: number;
  targetDateStart: string;
  targetDateEnd: string;
  submittedDate: string;
  submittedUser: string;
  comments: string;
}

@Injectable({ providedIn: 'root' })
export class DataService {
  private readonly rows: SortPairRow[] = [
    { id: 11728, number: 4,  targetDateStart: '06/12/2026', targetDateEnd: '06/13/2026', submittedDate: '06/11/2026 04:55 AM', submittedUser: '100001 - Vignesh Suresh',       comments: 'This test is to ensure if only the - and _ are allowed in the comments' },
    { id: 11727, number: 8,  targetDateStart: '06/12/2026', targetDateEnd: '06/14/2026', submittedDate: '06/11/2026 01:40 AM', submittedUser: '100002 - Sowmiya Srinivasan',    comments: '' },
    { id: 11726, number: 4,  targetDateStart: '06/11/2026', targetDateEnd: '06/15/2026', submittedDate: '06/09/2026 02:56 AM', submittedUser: '100001 - Vignesh Suresh',       comments: '' },
    { id: 11725, number: 4,  targetDateStart: '06/09/2026', targetDateEnd: '06/10/2026', submittedDate: '06/08/2026 12:17 PM', submittedUser: '100003 - Oscar Lopez',      comments: '' },
    { id: 11724, number: 4,  targetDateStart: '06/11/2026', targetDateEnd: '06/15/2026', submittedDate: '06/08/2026 09:42 AM', submittedUser: '100001 - Vignesh Suresh',       comments: 'Test with New li' },
    { id: 11723, number: 6,  targetDateStart: '06/05/2026', targetDateEnd: '06/07/2026', submittedDate: '06/04/2026 11:30 AM', submittedUser: '100002 - Sowmiya Srinivasan',    comments: 'Performance validation' },
    { id: 11722, number: 2,  targetDateStart: '06/03/2026', targetDateEnd: '06/04/2026', submittedDate: '06/02/2026 08:15 AM', submittedUser: '100003 - Oscar Lopez',      comments: 'Edge case: empty comment' },
    { id: 11721, number: 10, targetDateStart: '06/01/2026', targetDateEnd: '06/06/2026', submittedDate: '05/31/2026 03:00 PM', submittedUser: '100001 - Vignesh Suresh',       comments: 'Bulk test run for Q2' },
    { id: 11720, number: 3,  targetDateStart: '05/28/2026', targetDateEnd: '05/30/2026', submittedDate: '05/27/2026 10:00 AM', submittedUser: '100004 - Priya Nair',           comments: '' },
    { id: 11719, number: 5,  targetDateStart: '05/25/2026', targetDateEnd: '05/27/2026', submittedDate: '05/24/2026 02:20 PM', submittedUser: '100002 - Sowmiya Srinivasan',    comments: 'Regression check' },
    { id: 11718, number: 7,  targetDateStart: '05/22/2026', targetDateEnd: '05/25/2026', submittedDate: '05/21/2026 07:45 AM', submittedUser: '100003 - Oscar Lopez',      comments: '' },
    { id: 11717, number: 4,  targetDateStart: '05/19/2026', targetDateEnd: '05/21/2026', submittedDate: '05/18/2026 01:10 PM', submittedUser: '100001 - Vignesh Suresh',       comments: 'Initial load test' },
    { id: 11716, number: 9,  targetDateStart: '05/16/2026', targetDateEnd: '05/20/2026', submittedDate: '05/15/2026 09:30 AM', submittedUser: '100004 - Priya Nair',           comments: 'Multi-range validation' },
    { id: 11715, number: 1,  targetDateStart: '05/13/2026', targetDateEnd: '05/14/2026', submittedDate: '05/12/2026 11:00 AM', submittedUser: '100002 - Sowmiya Srinivasan',    comments: '' },
    { id: 11714, number: 6,  targetDateStart: '05/10/2026', targetDateEnd: '05/13/2026', submittedDate: '05/09/2026 04:00 PM', submittedUser: '100001 - Vignesh Suresh',       comments: 'UAT sign-off' },
    { id: 11713, number: 2,  targetDateStart: '05/07/2026', targetDateEnd: '05/09/2026', submittedDate: '05/06/2026 08:00 AM', submittedUser: '100003 - Oscar Lopez',      comments: '' },
    { id: 11712, number: 4,  targetDateStart: '05/04/2026', targetDateEnd: '05/06/2026', submittedDate: '05/03/2026 10:50 AM', submittedUser: '100004 - Priya Nair',           comments: 'Schema update test' },
    { id: 11711, number: 8,  targetDateStart: '05/01/2026', targetDateEnd: '05/04/2026', submittedDate: '04/30/2026 03:45 PM', submittedUser: '100002 - Sowmiya Srinivasan',    comments: '' },
    { id: 11710, number: 3,  targetDateStart: '04/28/2026', targetDateEnd: '04/30/2026', submittedDate: '04/27/2026 06:15 AM', submittedUser: '100001 - Vignesh Suresh',       comments: 'Sprint 14 closure' },
    { id: 11709, number: 5,  targetDateStart: '04/25/2026', targetDateEnd: '04/27/2026', submittedDate: '04/24/2026 02:00 PM', submittedUser: '100003 - Oscar Lopez',      comments: '' },
    { id: 11708, number: 11, targetDateStart: '04/22/2026', targetDateEnd: '04/26/2026', submittedDate: '04/21/2026 09:10 AM', submittedUser: '100004 - Priya Nair',           comments: 'Full regression suite' },
    { id: 11707, number: 4,  targetDateStart: '04/19/2026', targetDateEnd: '04/21/2026', submittedDate: '04/18/2026 01:30 PM', submittedUser: '100002 - Sowmiya Srinivasan',    comments: '' },
    { id: 11706, number: 6,  targetDateStart: '04/16/2026', targetDateEnd: '04/19/2026', submittedDate: '04/15/2026 10:20 AM', submittedUser: '100001 - Vignesh Suresh',       comments: 'Pre-prod smoke test' },
    { id: 11705, number: 2,  targetDateStart: '04/13/2026', targetDateEnd: '04/15/2026', submittedDate: '04/12/2026 07:00 AM', submittedUser: '100003 - Oscar Lopez',      comments: '' },
    { id: 11704, number: 4,  targetDateStart: '04/10/2026', targetDateEnd: '04/12/2026', submittedDate: '04/09/2026 03:30 PM', submittedUser: '100004 - Priya Nair',           comments: 'Data integrity check' },
    { id: 11703, number: 7,  targetDateStart: '04/07/2026', targetDateEnd: '04/10/2026', submittedDate: '04/06/2026 11:45 AM', submittedUser: '100002 - Sowmiya Srinivasan',    comments: '' },
    { id: 11702, number: 5,  targetDateStart: '04/04/2026', targetDateEnd: '04/06/2026', submittedDate: '04/03/2026 08:30 AM', submittedUser: '100001 - Vignesh Suresh',       comments: 'Hotfix validation' },
    { id: 11701, number: 3,  targetDateStart: '04/01/2026', targetDateEnd: '04/03/2026', submittedDate: '03/31/2026 05:00 PM', submittedUser: '100003 - Oscar Lopez',      comments: '' },
    { id: 11700, number: 9,  targetDateStart: '03/29/2026', targetDateEnd: '04/01/2026', submittedDate: '03/28/2026 10:15 AM', submittedUser: '100004 - Priya Nair',           comments: 'Q1 final sign-off' },
    { id: 11699, number: 4,  targetDateStart: '03/26/2026', targetDateEnd: '03/28/2026', submittedDate: '03/25/2026 02:40 PM', submittedUser: '100001 - Vignesh Suresh',       comments: 'Baseline snapshot' },
  ];

  getAll(): SortPairRow[] {
    return this.rows.map(r => ({ ...r }));
  }

  // ── Schema-driven grid columns ─────────────────────────────────────────────
  /** Build AG Grid column defs straight from the shared schema (single source of truth). */
  getColumnDefs(): (ColDef | ColGroupDef)[] {
    const agFilter = (kind: ColKind) => (filterTypeOf(kind) === 'number' ? 'agNumberColumnFilter' : 'agTextColumnFilter');
    const toColDef = (id: string): ColDef => {
      const f = GRID_SCHEMA.fields.find(x => x.id === id)!;
      const def: ColDef = {
        field: f.id,
        headerName: f.header,
        filter: agFilter(f.kind),
        sortable: true,
        floatingFilter: true,
      };
      if (f.width) def.width = f.width;
      if (f.minWidth) def.minWidth = f.minWidth;
      if (f.flex) def.flex = f.flex;
      if (f.sort) def.sort = f.sort;
      if (f.tooltip) def.tooltipField = f.id;
      return def;
    };

    // Leading selection checkbox column.
    const cols: (ColDef | ColGroupDef)[] = [{
      headerName: '', field: 'checkbox' as never,
      checkboxSelection: true, headerCheckboxSelection: true,
      width: 48, minWidth: 48, maxWidth: 48, pinned: 'left',
      resizable: false, sortable: false, filter: false, suppressHeaderMenuButton: true,
    }];

    const emitted = new Set<string>();
    for (const f of GRID_SCHEMA.fields) {
      if (emitted.has(f.id)) continue;
      const group = f.group ? GRID_SCHEMA.groups.find(g => g.id === f.group) : undefined;
      if (group) {
        cols.push({
          headerName: group.header,
          headerClass: 'col-group-header',
          children: group.fields.map(toColDef),
        } as ColGroupDef);
        group.fields.forEach(id => emitted.add(id));
      } else {
        cols.push(toColDef(f.id));
        emitted.add(f.id);
      }
    }
    return cols;
  }

  // ── Dynamic / large-dataset source ─────────────────────────────────────────
  /**
   * Produce a dataset of any size for scale testing. Rows beyond the base 30 are
   * synthesized by cloning + perturbing the seed rows, keeping ids unique.
   * Client-side AG Grid handles tens of thousands of rows with pagination fine;
   * for millions, swap this for the server-side/infinite row model + a backend.
   */
  generate(count: number): SortPairRow[] {
    const base = this.rows;
    if (count <= base.length) return base.slice(0, count).map(r => ({ ...r }));
    const out: SortPairRow[] = base.map(r => ({ ...r }));
    let nextId = Math.max(...base.map(r => r.id)) + 1;
    while (out.length < count) {
      const seed = base[out.length % base.length];
      out.push({ ...seed, id: nextId++, number: 1 + ((seed.number + out.length) % 11) });
    }
    return out;
  }
}
