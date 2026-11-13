import React, { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import { Download } from 'lucide-react';

interface EChartBoxProps {
  title: string;
  subtitle?: string;
  caption?: string;
  option: echarts.EChartsOption;
  height?: number;
  darkMode?: boolean;
  testId?: string;
}

export const EChartBox: React.FC<EChartBoxProps> = ({
  title,
  subtitle,
  caption,
  option,
  height = 300,
  darkMode = false,
  testId,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (chartRef.current) {
      chartRef.current.dispose();
    }
    const instance = echarts.init(el, darkMode ? 'dark' : undefined);
    chartRef.current = instance;

    const merged: echarts.EChartsOption = {
      backgroundColor: 'transparent',
      textStyle: {
        fontFamily: "'DM Sans', system-ui, sans-serif",
      },
      ...option,
    };
    instance.setOption(merged, true);

    const observer = new ResizeObserver(() => {
      instance.resize();
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      instance.dispose();
      chartRef.current = null;
    };
  }, [option, darkMode]);

  const handleExportPng = () => {
    if (!chartRef.current) return;
    const url = chartRef.current.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: darkMode ? '#0f172a' : '#ffffff' });
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.png`;
    a.click();
  };

  return (
    <section
      className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 flex flex-col gap-3"
      data-testid={testId}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 font-display truncate">
            {title}
          </h3>
          {subtitle && (
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{subtitle}</p>
          )}
        </div>
        <button
          type="button"
          onClick={handleExportPng}
          aria-label={`Export ${title} as PNG`}
          className="px-2.5 py-1 text-xs font-medium text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
        >
          <Download className="w-3.5 h-3.5" aria-hidden="true" />
          PNG
        </button>
      </div>
      <div ref={containerRef} style={{ width: '100%', height: `${height}px` }} />
      {caption && (
        <p className="text-xs text-slate-500 dark:text-slate-400 border-t border-slate-100 dark:border-slate-800 pt-2">
          {caption}
        </p>
      )}
    </section>
  );
};
