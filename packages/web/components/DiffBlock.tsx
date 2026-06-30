import clsx from 'clsx';

const DIFF_MAX_LINES = 28;

/** One diff line, coloured by its marker column: '+' added, '-' removed, ' ' context. */
function DiffRow({ row }: { row: string }) {
  const marker = row[0];
  return (
    <div
      className={clsx(
        'whitespace-pre',
        marker === '+' && 'bg-success/10 text-success',
        marker === '-' && 'bg-destructive/10 text-destructive',
        marker !== '+' && marker !== '-' && 'text-muted-foreground',
      )}
    >
      {row}
    </div>
  );
}

/** Renders an edit/write tool result (a diff block) as a change card body. */
export function DiffBlock({ result, maxLines = DIFF_MAX_LINES }: { result: string; maxLines?: number }) {
  const [summary, ...rows] = result.split('\n');
  const shown = rows.slice(0, maxLines);
  const overflow = rows.length - shown.length;

  return (
    <div className="mt-2 overflow-hidden rounded-sm border border-border">
      <div className="border-b border-border bg-muted px-3 py-1.5 font-mono text-xs font-medium text-success">
        {summary}
      </div>
      <div className="overflow-x-auto px-3 py-2 font-mono text-xs leading-6">
        {shown.map((row, index) => (
          <DiffRow key={index} row={row} />
        ))}
        {overflow > 0 ? <div className="text-muted-foreground">… +{overflow} more lines</div> : null}
      </div>
    </div>
  );
}
