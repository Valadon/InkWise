import { joinPath, type DeviceFs } from './fs';

const MAX_LINES = 400;

/**
 * A plain-text log in MyStyle/Inkwise that the user can copy off the device
 * and share, because a plugin can't show us its console. It never holds the
 * token. Writing it never asks for a permission: without file write access
 * the lines are dropped.
 */
export class DeviceLog {
  private lines: string[] | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private fs: DeviceFs,
    private canWrite: () => Promise<boolean>,
    readonly dir: string,
    private version: string,
    private now: () => Date = () => new Date(),
  ) {}

  get path() {
    return joinPath(this.dir, 'inkwise-log.txt');
  }

  add(line: string): Promise<void> {
    const stamped = `${this.now().toISOString()} [${this.version}] ${line.replace(/\s*\n\s*/g, ' ')}`;
    // One write at a time, in order, so lines never overwrite each other.
    this.writing = this.writing.then(() => this.append(stamped)).catch(() => {});
    return this.writing;
  }

  private async append(line: string) {
    if (!(await this.canWrite())) return;
    if (!this.lines) {
      this.lines = (await this.fs.exists(this.path)) ? (await this.fs.readText(this.path)).split('\n').filter(Boolean) : [];
    }
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    await this.fs.mkdir(this.dir);
    await this.fs.writeText(this.path, `${this.lines.join('\n')}\n`);
  }
}

/** A short, single-line preview of a highlight for the log. */
export function preview(text: string, max = 40): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `"${t.slice(0, max)}…" (${t.length} chars)` : `"${t}"`;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
