import { createHash } from 'node:crypto';
import type { OutputAdapter, RemoteFile } from '@inkwise/core';

/**
 * Supernote Cloud, reverse-engineered. There is no official API; this follows
 * what working community clients do (the Obsidian "Supernote Cloud Sync" plugin
 * and the "Send to Supernote" extension). Expect it to break if Ratta changes
 * the endpoints, which is why it sits behind the adapter interface.
 *
 * Only the session token is ever stored, never the password.
 */

export const SUPERNOTE_HOSTS = ['https://cloud.supernote.com/api', 'https://viewer.supernote.com/api'];

export class SupernoteCloudError extends Error {
  constructor(message: string, readonly code?: string | null, readonly authExpired = false) {
    super(message);
    this.name = 'SupernoteCloudError';
  }
}

interface FileVO {
  id: string | number;
  directoryId: string | number;
  fileName: string;
  size: number;
  md5: string;
  isFolder: 'Y' | 'N' | boolean;
}

type Envelope<T = {}> = { success: boolean; errorCode?: string | null; errorMsg?: string | null } & T;

/** Low-level client shared by the adapter and the login command. */
export class SupernoteCloudClient {
  private xsrf: string | undefined;
  private hostIndex = 0;

  constructor(
    public token: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly hosts: string[] = SUPERNOTE_HOSTS,
  ) {}

  get base() {
    return this.hosts[this.hostIndex]!;
  }

  async api<T = {}>(path: string, body: unknown, auth = true): Promise<Envelope<T>> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (auth) {
        if (!this.token) throw new SupernoteCloudError('Not signed in to Supernote Cloud. Run `inkwise supernote-login`.', null, true);
        headers['x-access-token'] = this.token;
      }
      if (this.xsrf) headers['X-XSRF-TOKEN'] = this.xsrf;
      const res = await this.fetchImpl(this.base + path, { method: 'POST', headers, body: JSON.stringify(body) });
      const x = res.headers.get('x-xsrf-token');
      if (x) this.xsrf = x;
      const text = await res.text();
      let json: any = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = {};
      }
      if (res.status === 403 && isCsrfFailure(json)) {
        // First try a fresh CSRF token; if that doesn't help, fall back to the viewer host.
        if (attempt === 0 && (await this.refreshCsrf())) continue;
        if (this.hostIndex < this.hosts.length - 1) {
          this.hostIndex++;
          this.xsrf = undefined;
          continue;
        }
        // Not a session problem, so don't send the user off to log in again.
        throw new SupernoteCloudError(`Supernote Cloud ${path} kept failing CSRF checks.`, json?.code ?? null);
      }
      if (res.status === 401 || res.status === 403 || json?.errorCode === 'E0401') {
        throw new SupernoteCloudError('Supernote Cloud session expired. Run `inkwise supernote-login` again.', json?.errorCode, true);
      }
      if (!res.ok) throw new SupernoteCloudError(`Supernote Cloud ${path} failed (HTTP ${res.status}).`, json?.errorCode);
      return json as Envelope<T>;
    }
    throw new SupernoteCloudError(`Supernote Cloud ${path} kept failing CSRF checks.`);
  }

  private async refreshCsrf(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.base}/csrf`, { method: 'GET' });
      const x = res.headers.get('x-xsrf-token');
      if (x) this.xsrf = x;
      return !!x;
    } catch {
      return false;
    }
  }

  async listAll(directoryId: string): Promise<FileVO[]> {
    const out: FileVO[] = [];
    for (let pageNo = 1; pageNo <= 100; pageNo++) {
      const r = await this.ok(
        this.api<{ total: number; userFileVOList: FileVO[] }>('/file/list/query', {
          directoryId: directoryId === '0' ? 0 : directoryId,
          pageNo,
          pageSize: 100,
          order: 'time',
          sequence: 'desc',
        }),
        'list folder',
      );
      const items = r.userFileVOList ?? [];
      out.push(...items);
      if (items.length < 100 || out.length >= (r.total ?? 0)) break;
    }
    return out;
  }

  async ok<T>(p: Promise<Envelope<T>>, what: string): Promise<Envelope<T>> {
    const r = await p;
    if (!r.success) {
      const expired = r.errorCode === 'E0401';
      throw new SupernoteCloudError(
        expired ? 'Supernote Cloud session expired. Run `inkwise supernote-login` again.' : `Supernote Cloud ${what} failed: ${r.errorMsg ?? r.errorCode ?? 'unknown error'}`,
        r.errorCode,
        expired,
      );
    }
    return r;
  }

  /** Find (or create) a folder path such as ["Document", "Inkwise"]; returns its id. */
  async ensurePath(names: string[], create: boolean): Promise<string | null> {
    let dirId = '0';
    for (const name of names) {
      let items = await this.listAll(dirId);
      let hit = items.find((i) => isFolder(i) && i.fileName.toLowerCase() === name.toLowerCase());
      if (!hit) {
        if (!create) return null;
        await this.ok(this.api('/file/folder/add', { directoryId: dirId === '0' ? 0 : dirId, fileName: name }), `create folder ${name}`);
        items = await this.listAll(dirId);
        hit = items.find((i) => isFolder(i) && i.fileName === name);
        if (!hit) throw new SupernoteCloudError(`Created folder ${name} but could not find it again.`);
      }
      dirId = String(hit.id);
    }
    return dirId;
  }

  // --- login -------------------------------------------------------------

  async startLogin(account: string, password: string): Promise<
    { kind: 'token'; token: string } | { kind: 'verify'; timestamp: number; validCodeKey: string }
  > {
    const r = await this.ok(
      this.api<{ randomCode: string; timestamp: number }>('/official/user/query/random/code', { countryCode: '1', account }, false),
      'login',
    );
    const login = await this.api<{ token: string }>(
      '/official/user/account/login/new',
      {
        countryCode: 1,
        account,
        password: sha256Hex(md5Hex(password) + r.randomCode),
        browser: 'Chrome107',
        equipment: '1',
        loginMethod: '1',
        timestamp: r.timestamp,
        language: 'en',
      },
      false,
    );
    if (login.success && login.token) return { kind: 'token', token: login.token };
    if (login.errorCode !== 'E1760') {
      throw new SupernoteCloudError(`Supernote Cloud login failed: ${login.errorMsg ?? login.errorCode ?? 'unknown error'}`, login.errorCode);
    }
    // New-device check: Supernote emails a 6-character code.
    const pre = await this.ok(this.api<{ token: string }>('/user/validcode/pre-auth', { account }, false), 'verification');
    const parts = pre.token.split('-');
    const secret = parts[Number(pre.token.at(-1))] ?? '';
    const sent = await this.ok(
      this.api<{ validCodeKey: string }>(
        '/user/mail/validcode/send',
        { email: account, timestamp: r.timestamp, token: pre.token, sign: sha256Hex(account + secret) },
        false,
      ),
      'send verification code',
    );
    return { kind: 'verify', timestamp: r.timestamp, validCodeKey: sent.validCodeKey };
  }

  async finishLogin(account: string, code: string, pending: { timestamp: number; validCodeKey: string }): Promise<string> {
    const v = await this.ok(
      this.api<{ token: string }>(
        '/official/user/sms/login',
        {
          email: account,
          validCode: code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6),
          validCodeKey: pending.validCodeKey,
          timestamp: pending.timestamp,
          browser: 'Chrome107',
          equipment: '4',
        },
        false,
      ),
      'verify code',
    );
    return v.token;
  }
}

export class SupernoteCloudOutput implements OutputAdapter {
  readonly name = 'supernote-cloud' as const;
  private dirId: string | null = null;
  private files = new Map<string, FileVO>();
  private listed = false;
  /** Names uploaded since the last listing; their new ids are unknown until we list again. */
  private stale = new Set<string>();

  constructor(
    private readonly client: SupernoteCloudClient,
    private readonly path: string[] = ['Document', 'Inkwise'],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async dir(create: boolean): Promise<string | null> {
    if (this.dirId) return this.dirId;
    this.dirId = await this.client.ensurePath(this.path, create);
    return this.dirId;
  }

  async list(): Promise<RemoteFile[]> {
    const dir = await this.dir(false);
    if (!dir) return [];
    const items = (await this.client.listAll(dir)).filter((i) => !isFolder(i));
    this.files = new Map(items.map((i) => [i.fileName, i]));
    this.listed = true;
    this.stale.clear();
    return items.map((i) => ({ name: i.fileName, size: i.size }));
  }

  async put(filename: string, bytes: Uint8Array): Promise<void> {
    const dir = (await this.dir(true))!;
    // Uploading over an existing name isn't documented anywhere; replace explicitly.
    const old = await this.known(filename);
    if (old) await this.deleteIds(dir, [old.id]);
    this.files.delete(filename);
    const md5 = md5Hex(bytes);
    const apply = await this.client.ok(
      this.client.api<{ url: string; s3Authorization: string; xamzDate: string; innerName?: string }>('/file/upload/apply', {
        directoryId: dir,
        fileName: filename,
        md5,
        size: bytes.byteLength,
      }),
      'upload',
    );
    const put = await this.fetchImpl(apply.url, {
      method: 'PUT',
      headers: {
        Authorization: apply.s3Authorization,
        'x-amz-date': apply.xamzDate,
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      },
      body: bytes,
    });
    if (!put.ok) throw new SupernoteCloudError(`Supernote Cloud storage upload failed (HTTP ${put.status}).`);
    const innerName = apply.innerName || new URL(apply.url).pathname.split('/').pop()!;
    await this.client.ok(
      this.client.api('/file/upload/finish', { directoryId: dir, fileName: filename, fileSize: bytes.byteLength, innerName, md5 }),
      'finish upload',
    );
    this.stale.add(filename);
  }

  async remove(filename: string): Promise<void> {
    const dir = await this.dir(false);
    if (!dir) return;
    const f = await this.known(filename);
    if (f) await this.deleteIds(dir, [f.id]);
    this.files.delete(filename);
    this.stale.delete(filename);
  }

  /** The current remote entry for a name, listing first if we haven't yet or uploaded it since. */
  private async known(filename: string): Promise<FileVO | undefined> {
    if (!this.listed || this.stale.has(filename)) await this.list();
    return this.files.get(filename);
  }

  private async deleteIds(dir: string, ids: (string | number)[]) {
    await this.client.ok(this.client.api('/file/delete', { directoryId: dir, idList: ids }), 'delete');
  }
}

function isFolder(i: FileVO) {
  return i.isFolder === 'Y' || i.isFolder === true;
}

function isCsrfFailure(json: any): boolean {
  const code = json?.code;
  return code === 'CSRF_TOKEN_EXPIRED' || code === 'INVALID_CSRF_TOKEN' || (!json?.errorCode && /csrf/i.test(String(json?.error ?? '')));
}

export function md5Hex(data: Uint8Array | string): string {
  return createHash('md5').update(data).digest('hex');
}

export function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Seconds until a JWT expires, or null if it can't be read. */
export function jwtExpiresIn(token: string, now = Date.now()): number | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof payload.exp === 'number' ? Math.round(payload.exp - now / 1000) : null;
  } catch {
    return null;
  }
}
