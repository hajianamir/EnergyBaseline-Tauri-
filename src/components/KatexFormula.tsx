import React, { useMemo } from 'react';
import katex from 'katex';

interface KatexFormulaProps {
  latex: string;
  displayMode?: boolean;
  className?: string;
}

export const KatexFormula: React.FC<KatexFormulaProps> = ({
  latex,
  displayMode = true,
  className = '',
}) => {
  const html = useMemo(() => {
    try {
      return katex.renderToString(latex, {
        displayMode,
        throwOnError: false,
        strict: false,
      });
    } catch {
      return latex;
    }
  }, [latex, displayMode]);

  return (
    <div
      className={`overflow-x-auto max-w-full rounded-md bg-slate-50/80 dark:bg-slate-950/70 border border-slate-200/80 dark:border-slate-800 px-3 py-2 text-xs sm:text-sm text-slate-900 dark:text-slate-100 [&_.katex-display]:!text-left [&_.katex-display]:!my-0 [&_.katex-display]:!overflow-x-auto [&_.katex-display]:!overflow-y-hidden [&_.katex]:text-[0.88em] ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
