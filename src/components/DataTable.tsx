import React, { useMemo, useRef, useState } from 'react';
import {
  columnFilteringFeature,
  createColumnHelper,
  createFilteredRowModel,
  createSortedRowModel,
  filterFns,
  globalFilteringFeature,
  rowSortingFeature,
  sortFns,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ArrowUpDown, Download, Search } from 'lucide-react';

export interface SimpleColumnDef<T extends Record<string, unknown>> {
  key: keyof T & string;
  header: string;
  width?: number;
  align?: 'left' | 'right';
  render?: (val: T[keyof T], row: T) => React.ReactNode;
}

interface DataTableProps<T extends Record<string, unknown>> {
  data: T[];
  columns: SimpleColumnDef<T>[];
  maxHeight?: number;
  exportFileName?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
}

const features = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  filterFns,
  sortFns,
});

export function DataTable<T extends Record<string, unknown>>({
  data,
  columns,
  maxHeight = 360,
  exportFileName = 'table_export.csv',
  searchPlaceholder = 'Filter rows...',
  emptyMessage = 'No records match the current filter.',
}: DataTableProps<T>) {
  const [globalFilter, setGlobalFilter] = useState('');
  const [sorting, setSorting] = useState<{ id: string; desc: boolean }[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const tanstackColumns = useMemo(() => {
    const helper = createColumnHelper<typeof features, T>();
    return helper.columns(
      columns.map((col) =>
        helper.accessor((row) => row[col.key] as unknown, {
          id: col.key,
          header: col.header,
          cell: (ctx) => {
            const val = ctx.getValue() as T[keyof T];
            if (col.render) return col.render(val, ctx.row.original);
            if (val === null || val === undefined || val === '') return '—';
            if (typeof val === 'number') return Number.isInteger(val) ? String(val) : val.toFixed(3);
            return String(val);
          },
        })
      )
    );
  }, [columns]);

  const table = useTable({
    features,
    columns: tanstackColumns,
    data,
    state: {
      globalFilter,
      sorting,
    },
    onGlobalFilterChange: setGlobalFilter,
    onSortingChange: setSorting,
  });

  const rows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 38,
    overscan: 8,
  });

  const handleExportCsv = () => {
    const headerLine = columns.map((c) => `"${c.header}"`).join(',');
    const bodyLines = rows.map((r) =>
      columns
        .map((c) => {
          const v = r.original[c.key];
          return `"${String(v ?? '').replace(/"/g, '""')}"`;
        })
        .join(',')
    );
    const blob = new Blob([[headerLine, ...bodyLines].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const totalWidth = columns.reduce((acc, c) => acc + (c.width ?? 140), 0);

  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
          <input
            type="search"
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-600"
          />
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
          <span>
            {rows.length.toLocaleString()} / {data.length.toLocaleString()} rows
          </span>
          <button
            type="button"
            onClick={handleExportCsv}
            className="px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            Export CSV
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="overflow-auto" style={{ maxHeight: `${maxHeight}px` }}>
        <div style={{ minWidth: `${totalWidth}px` }}>
          {/* Sticky Header */}
          <div className="sticky top-0 z-10 flex bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300">
            {table.getHeaderGroups().map((hg) =>
              hg.headers.map((header) => {
                const colDef = columns.find((c) => c.key === header.id);
                const sorted = header.column.getIsSorted();
                return (
                  <button
                    key={header.id}
                    type="button"
                    onClick={header.column.getToggleSortingHandler()}
                    style={{ width: `${colDef?.width ?? 140}px`, flexShrink: 0 }}
                    className={`px-3 py-2 flex items-center gap-1.5 hover:bg-slate-100 dark:hover:bg-slate-800/70 transition-colors text-left ${
                      colDef?.align === 'right' ? 'justify-end' : 'justify-start'
                    }`}
                  >
                    <span className="truncate">
                      <table.FlexRender header={header} />
                    </span>
                    {sorted === 'asc' ? (
                      <ArrowUp className="w-3 h-3 shrink-0 text-sky-600" aria-hidden="true" />
                    ) : sorted === 'desc' ? (
                      <ArrowDown className="w-3 h-3 shrink-0 text-sky-600" aria-hidden="true" />
                    ) : (
                      <ArrowUpDown className="w-3 h-3 shrink-0 opacity-35" aria-hidden="true" />
                    )}
                  </button>
                );
              })
            )}
          </div>

          {/* Virtualized Rows */}
          {rows.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-500 dark:text-slate-400">
              {emptyMessage}
            </div>
          ) : (
            <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
              {virtualizer.getVirtualItems().map((vRow) => {
                const row = rows[vRow.index];
                return (
                  <div
                    key={row.id}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: `${vRow.size}px`,
                      transform: `translateY(${vRow.start}px)`,
                    }}
                    className="flex items-center border-b border-slate-100 dark:border-slate-800/70 hover:bg-slate-50/80 dark:hover:bg-slate-800/40 text-xs text-slate-800 dark:text-slate-200 tabular-nums"
                  >
                    {row.getAllCells().map((cell) => {
                      const colDef = columns.find((c) => c.key === cell.column.id);
                      return (
                        <div
                          key={cell.id}
                          style={{ width: `${colDef?.width ?? 140}px`, flexShrink: 0 }}
                          className={`px-3 py-1.5 truncate ${
                            colDef?.align === 'right' ? 'text-right font-mono' : 'text-left'
                          }`}
                        >
                          <table.FlexRender cell={cell} />
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
