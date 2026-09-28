import { type Style, visibleWidth } from "./style.ts";

export type Align = "left" | "right";

type Row = { cells: string[] } | { separator: true };

const ANSI = /\x1b\[[0-9;]*m/g;

const splitWords = (text: string): string[] => text.split(/(\s+)/).filter((part) => part.length > 0);

const hardWrap = (text: string, width: number): string[] => {
  const out: string[] = [];
  let current = "";
  for (const char of text) {
    if (visibleWidth(current + char) > width) {
      out.push(current);
      current = char;
    } else current += char;
  }
  if (current) out.push(current);
  return out;
};

const wrapLine = (line: string, width: number): string[] => {
  if (visibleWidth(line) <= width) return [line];
  const plain = line.replace(ANSI, "");
  const colored = plain !== line;
  const prefix = colored ? (/^(\x1b\[[0-9;]*m)/.exec(line)?.[1] ?? "") : "";
  const out: string[] = [];
  let current = "";
  for (const word of splitWords(plain)) {
    if (visibleWidth(current + word) <= width) {
      current += word;
      continue;
    }
    if (current.trim()) out.push(current.trimEnd());
    current = word.trimStart();
    if (visibleWidth(current) > width) {
      const pieces = hardWrap(current, width);
      current = pieces.pop() ?? "";
      out.push(...pieces);
    }
  }
  if (current.trim()) out.push(current.trimEnd());
  return colored ? out.map((part) => `${prefix}${part}\x1b[0m`) : out;
};

const truncate = (line: string, width: number): string => {
  if (visibleWidth(line) <= width) return line;
  const plain = line.replace(ANSI, "");
  let out = "";
  for (const char of plain) {
    if (visibleWidth(out + char) > width - 1) break;
    out += char;
  }
  return `${out}…`;
};

const DATE = /^\d{4}-\d{2}(-\d{2})?$/;

export class Table {
  private rows: Row[] = [];

  constructor(
    private headers: string[],
    private aligns: Align[],
    private style: Style,
    private terminalWidth: number,
  ) {}

  push(cells: string[]): void {
    this.rows.push({ cells });
  }

  separator(): void {
    this.rows.push({ separator: true });
  }

  private naturalWidths(): number[] {
    return this.headers.map((header, col) => {
      let width = visibleWidth(header);
      for (const row of this.rows) {
        if ("separator" in row) continue;
        for (const line of (row.cells[col] ?? "").split("\n")) width = Math.max(width, visibleWidth(line));
      }
      return width;
    });
  }

  private fitWidths(): number[] {
    const widths = this.naturalWidths();
    const longestWord = (text: string) => Math.max(0, ...text.split(/\s+/).map((p) => visibleWidth(p)));
    const floors = widths.map((w, col) => {
      const header = longestWord(this.headers[col] ?? "");
      if (this.aligns[col] === "right") {
        let longest = header;
        for (const row of this.rows) if (!("separator" in row)) for (const line of (row.cells[col] ?? "").split("\n")) longest = Math.max(longest, visibleWidth(line));
        return Math.min(w, longest);
      }
      return Math.min(w, Math.max(col === 0 ? 5 : 8, Math.min(header, 12)));
    });
    const total = () => widths.reduce((a, w) => a + w + 3, 1);
    while (total() > this.terminalWidth) {
      let pick = -1;
      for (let col = 0; col < widths.length; col++) {
        if (this.aligns[col] === "right" || widths[col]! <= floors[col]!) continue;
        if (pick < 0 || widths[col]! > widths[pick]!) pick = col;
      }
      if (pick < 0) {
        for (let col = 0; col < widths.length; col++) {
          if (this.aligns[col] !== "right" || widths[col]! <= floors[col]!) continue;
          if (pick < 0 || widths[col]! > widths[pick]!) pick = col;
        }
      }
      if (pick < 0) break;
      widths[pick]! -= 1;
    }
    return widths;
  }

  private cellLines(text: string, width: number, col: number, header: boolean): string[] {
    const lines: string[] = [];
    for (const line of text.split("\n")) {
      if (header) lines.push(...wrapLine(line, width).map((part) => truncate(part, width)));
      else if (col === 0 && DATE.test(line) && visibleWidth(line) > width) lines.push(line.slice(0, 4), line.slice(5));
      else lines.push(truncate(line, width));
    }
    return lines.length ? lines : [""];
  }

  private pad(text: string, width: number, align: Align): string {
    const gap = Math.max(width - visibleWidth(text), 0);
    return align === "right" ? " ".repeat(gap) + text : text + " ".repeat(gap);
  }

  render(): string {
    const widths = this.fitWidths();
    const border = (l: string, m: string, r: string) => l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
    const renderCells = (cells: string[], header: boolean): string[] => {
      const columns = cells.map((cell, col) => this.cellLines(cell, widths[col]!, col, header));
      const height = Math.max(...columns.map((c) => c.length));
      const out: string[] = [];
      for (let i = 0; i < height; i++) {
        const parts = columns.map((lines, col) => {
          const text = lines[i] ?? "";
          const padded = this.pad(text, widths[col]!, this.aligns[col]!);
          return header ? this.style.color(padded, "blue") : padded;
        });
        out.push(`│ ${parts.join(" │ ")} │`);
      }
      return out;
    };
    const lines = [border("┌", "┬", "┐"), ...renderCells(this.headers, true)];
    for (const row of this.rows) {
      if ("separator" in row) continue;
      lines.push(border("├", "┼", "┤"), ...renderCells(row.cells, false));
    }
    lines.push(border("└", "┴", "┘"));
    return lines.join("\n");
  }
}

export const boxTitle = (title: string, style: Style): string => {
  const titleLines = title.split("\n");
  const content = Math.max(40, ...titleLines.map((l) => visibleWidth(l))) + 2;
  const out = ["", `╭${"─".repeat(content + 2)}╮`, `│${" ".repeat(content + 2)}│`];
  for (const line of titleLines) {
    const padding = content - visibleWidth(line);
    const left = Math.floor(padding / 2);
    out.push(`│ ${" ".repeat(left)}${style.color(line, "blue")}${" ".repeat(padding - left)} │`);
  }
  out.push(`│${" ".repeat(content + 2)}│`, `╰${"─".repeat(content + 2)}╯`, "");
  return out.join("\n");
};
