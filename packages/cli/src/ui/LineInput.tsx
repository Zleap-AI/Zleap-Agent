import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';

type LineInputProps = {
  value: string;
  focus: boolean;
  /** Visible character width; the text scrolls horizontally within it. */
  width: number;
  mask?: string;
  placeholder?: string;
  /** When true, ↑↓ navigate an external menu instead of moving between lines. */
  captureVerticalArrows?: boolean;
  onVerticalArrow?: (delta: number) => void;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
};

/**
 * Fixed-height input: one visible row with horizontal scroll. The value may
 * contain newlines (shift+enter); up/down move between lines without growing
 * the prompt box or pushing conversation content upward.
 */
export function LineInput({
  value,
  focus,
  width,
  mask,
  placeholder,
  captureVerticalArrows = false,
  onVerticalArrow,
  onChange,
  onSubmit,
}: LineInputProps): ReactElement {
  const [cursor, setCursor] = useState(value.length);

  const lines = useMemo(() => value.split('\n'), [value]);
  const { line: lineIndex, col } = useMemo(() => offsetToLineCol(value, cursor), [value, cursor]);
  const currentLine = lines[lineIndex] ?? '';
  const displayLine = mask ? mask.repeat(currentLine.length) : currentLine;

  // Re-sync the cursor when the value is replaced externally (e.g. cleared on submit).
  useEffect(() => {
    if (cursor > value.length) {
      setCursor(value.length);
    }
  }, [value, cursor]);

  useInput(
    (input, key) => {
      if (key.return && !key.shift) {
        onSubmit(value);
        setCursor(0);
        return;
      }
      if (key.return && key.shift) {
        insertAt(cursor, '\n');
        return;
      }
      if (key.leftArrow) {
        moveHorizontal(-1);
        return;
      }
      if (key.rightArrow) {
        moveHorizontal(1);
        return;
      }
      if (key.upArrow) {
        if (captureVerticalArrows) {
          onVerticalArrow?.(-1);
        } else {
          moveVertical(-1);
        }
        return;
      }
      if (key.downArrow) {
        if (captureVerticalArrows) {
          onVerticalArrow?.(1);
        } else {
          moveVertical(1);
        }
        return;
      }
      // macOS Backspace arrives as `delete` (0x7f); both mean delete-before-cursor here.
      if (key.backspace || key.delete) {
        if (cursor > 0) {
          onChange(value.slice(0, cursor - 1) + value.slice(cursor));
          setCursor(cursor - 1);
        }
        return;
      }
      // Ignore control/navigation keys handled elsewhere (exit, interrupt).
      if (key.ctrl || key.meta || key.escape || key.tab || key.pageUp || key.pageDown) {
        return;
      }
      if (input) {
        insertAt(cursor, input);
      }
    },
    { isActive: focus },
  );

  function insertAt(offset: number, text: string): void {
    onChange(value.slice(0, offset) + text + value.slice(offset));
    setCursor(offset + text.length);
  }

  function moveHorizontal(delta: number): void {
    const next = cursor + delta;
    if (next >= 0 && next <= value.length) {
      setCursor(next);
    }
  }

  function moveVertical(delta: number): void {
    const targetLine = lineIndex + delta;
    if (targetLine < 0 || targetLine >= lines.length) {
      return;
    }
    setCursor(lineColToOffset(value, targetLine, col));
  }

  if (displayLine.length === 0 && value.length === 0) {
    return (
      <Text>
        {focus ? <Text inverse> </Text> : ' '}
        {placeholder ? <Text dimColor>{placeholder.slice(0, Math.max(0, width - 1))}</Text> : null}
      </Text>
    );
  }

  // Horizontal scroll window on the active line only.
  const previewStart = Math.max(0, lineIndex - 2);
  const previewLines = lines.slice(previewStart, lineIndex);

  let start = 0;
  if (displayLine.length >= width) {
    const lead = Math.floor(width * 0.7);
    start = Math.min(Math.max(0, col - lead), Math.max(0, displayLine.length - width + 1));
  }
  const view = displayLine.slice(start, start + width);
  const cursorCol = col - start;
  const before = view.slice(0, cursorCol);
  const atChar = view.slice(cursorCol, cursorCol + 1) || ' ';
  const after = view.slice(cursorCol + 1);

  return (
    <Box flexDirection="column">
      {previewLines.map((line, index) => (
        <Text key={`${previewStart + index}`} dimColor>
          {mask ? mask.repeat(line.length) : line}
        </Text>
      ))}
      <Text>
        {before}
        {focus ? <Text inverse>{atChar}</Text> : atChar}
        {after}
      </Text>
    </Box>
  );
}

function offsetToLineCol(text: string, offset: number): { line: number; col: number } {
  let line = 0;
  let col = 0;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i += 1) {
    if (text[i] === '\n') {
      line += 1;
      col = 0;
    } else {
      col += 1;
    }
  }
  return { line, col };
}

function lineColToOffset(text: string, line: number, col: number): number {
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < line; i += 1) {
    offset += (lines[i]?.length ?? 0) + 1;
  }
  offset += Math.min(col, lines[line]?.length ?? 0);
  return offset;
}
