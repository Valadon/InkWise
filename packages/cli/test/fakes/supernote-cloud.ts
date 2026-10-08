import { createHash } from 'node:crypto';

/**
 * In-memory fake of the (reverse-engineered) Supernote Cloud API, following
 * the community-client protocol notes: random code + hashed-password login,
 * the E1760 new-device email check, paginated listing, folder creation, the
 * apply -> S3 PUT -> finish upload, delete, CSRF on cloud.supernote.com and
 * E0401 for dead sessions. Every value here is fake.
 */

export const CLOUD = 'https://cloud.supernote.com/api';
export const VIEWER = 'https://viewer.supernote.com/api';
const S3 = 'https://fake-supernote-bucket.s3.us-east-1.amazonaws.com';

const md5 = (d: Uint8Array | string) => createHash('md5').update(d).digest('hex');
const sha256 = (d: string) => createHash('sha256').update(d).digest('hex');

export function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.fake-signature`;
}

export interface FakeNode {
  id: string;
  directoryId: string;
  fileName: string;
  size: number;
  md5: string;
  isFolder: 'Y' | 'N';
  bytes?: Uint8Array;
}

interface PendingUpload {
  directoryId: string;
  fileName: string;
  md5: string;
  size: number;
  authorization: string;
  xamzDate: string;
  bytes?: Uint8Array;
}

export interface Call {
  method: string;
  url: string;
  host: 'cloud' | 'viewer' | 's3' | 'other';
  path: string;
  headers: Record<string, string>;
  body: any;
}

export interface FakeOptions {
  /** 'off': no CSRF. 'required': cloud host wants X-XSRF-TOKEN from GET /csrf. 'cloud-broken': cloud host always fails CSRF. */
  csrf?: 'off' | 'required' | 'cloud-broken';
  /** Whether /file/upload/apply returns innerName (otherwise the client must take it from the URL). */
  innerNameInApply?: boolean;
  /** Ask new devices for an email code (E1760). */
  requireVerification?: boolean;
  /** How a dead session is reported. */
  expiredStyle?: 'E0401' | 'http401';
  account?: string;
  password?: string;
  /** Lowercase so folder lookups are proven to be case-insensitive. */
  documentFolderName?: string;
}

export class FakeSupernoteCloud {
  readonly account: string;
  readonly password: string;
  readonly csrfToken = 'fake-xsrf-token-123';
  readonly emailCode = 'AB12CD';
  readonly calls: Call[] = [];
  readonly nodes = new Map<string, FakeNode>();
  readonly validTokens = new Set<string>();
  readonly s3Puts: { url: string; headers: Record<string, string> }[] = [];
  private nextId = 900000000000000001n;
  private randomCodes = new Map<string, { randomCode: string; timestamp: number }>();
  private validCodeKeys = new Map<string, string>();
  private preAuth = new Map<string, string>();
  private uploads = new Map<string, PendingUpload>();
  private uploadCounter = 0;
  readonly opts: Required<FakeOptions>;

  constructor(opts: FakeOptions = {}) {
    this.opts = {
      csrf: 'off',
      innerNameInApply: true,
      requireVerification: false,
      expiredStyle: 'E0401',
      account: 'test@example.com',
      password: 'correct horse battery staple',
      documentFolderName: 'Document',
      ...opts,
    };
    this.account = this.opts.account;
    this.password = this.opts.password;
    // A fresh account has the system folders at root.
    for (const name of ['Note', this.opts.documentFolderName, 'EXPORT', 'MyStyle']) this.addFolder('0', name);
  }

  /** A valid session token (as if the user had logged in). */
  issueToken(expSecondsFromNow = 30 * 86400): string {
    const t = fakeJwt({ userId: 1234, equipmentNo: 'WEB', exp: Math.floor(Date.now() / 1000) + expSecondsFromNow, n: this.validTokens.size });
    this.validTokens.add(t);
    return t;
  }

  newId(): string {
    return String(this.nextId++);
  }

  addFolder(parent: string, name: string): FakeNode {
    const n: FakeNode = { id: this.newId(), directoryId: parent, fileName: name, size: 0, md5: '', isFolder: 'Y' };
    this.nodes.set(n.id, n);
    return n;
  }

  addFile(parent: string, name: string, bytes: Uint8Array): FakeNode {
    const n: FakeNode = { id: this.newId(), directoryId: parent, fileName: name, size: bytes.byteLength, md5: md5(bytes), isFolder: 'N', bytes };
    this.nodes.set(n.id, n);
    return n;
  }

  children(dirId: string): FakeNode[] {
    return [...this.nodes.values()].filter((n) => n.directoryId === dirId);
  }

  findPath(names: string[]): FakeNode | undefined {
    let dir = '0';
    let hit: FakeNode | undefined;
    for (const name of names) {
      hit = this.children(dir).find((n) => n.isFolder === 'Y' && n.fileName === name);
      if (!hit) return undefined;
      dir = hit.id;
    }
    return hit;
  }

  callsTo(path: string) {
    return this.calls.filter((c) => c.path === path);
  }

  fetch: typeof fetch = async (input: any, init: any = {}) => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    let host: Call['host'] = 'other';
    let path = url;
    if (url.startsWith(CLOUD)) [host, path] = ['cloud', url.slice(CLOUD.length)];
    else if (url.startsWith(VIEWER)) [host, path] = ['viewer', url.slice(VIEWER.length)];
    else if (url.startsWith(S3)) [host, path] = ['s3', new URL(url).pathname];
    let body: any = init.body;
    if (typeof body === 'string' && headers['content-type']?.includes('json')) body = JSON.parse(body);
    this.calls.push({ method, url, host, path, headers, body });

    if (host === 's3') return this.s3(method, url, headers, init.body);
    if (host === 'other') return new Response('not found', { status: 404 });

    if (path === '/csrf' && method === 'GET') {
      return new Response('', { status: 200, headers: { 'X-XSRF-TOKEN': this.csrfToken } });
    }
    if (method !== 'POST') return new Response('method not allowed', { status: 405 });
    if (host === 'cloud' && this.opts.csrf !== 'off') {
      const ok = this.opts.csrf === 'required' && headers['x-xsrf-token'] === this.csrfToken;
      if (!ok) return json({ error: 'CSRF token validation failed', code: 'CSRF_TOKEN_EXPIRED' }, 403);
    }
    if (headers['content-type'] !== 'application/json') return json({ success: false, errorCode: '415', errorMsg: 'json only' }, 415);
    return this.route(path, body ?? {}, headers);
  };

  private route(path: string, b: any, headers: Record<string, string>): Response {
    // --- unauthenticated: login -------------------------------------------
    switch (path) {
      case '/official/user/query/random/code': {
        const rc = { randomCode: `rc${Math.random().toString(36).slice(2, 10)}`, timestamp: Date.now() };
        this.randomCodes.set(b.account, rc);
        return ok(rc);
      }
      case '/official/user/account/login/new': {
        const rc = this.randomCodes.get(b.account);
        if (!rc || b.timestamp !== rc.timestamp) return fail('E0018', 'timestamp mismatch');
        if (b.account !== this.account || b.password !== sha256(md5(this.password) + rc.randomCode)) {
          return fail('E0019', 'Incorrect account or password');
        }
        if (b.equipment !== '1') return fail('422', 'Request Parameter Serialisation Exception');
        if (this.opts.requireVerification) return fail('E1760', 'New device: verification required');
        return ok({ token: this.issueToken() });
      }
      case '/user/validcode/pre-auth': {
        // '-'-separated parts; the last character is the index of the secret part.
        const t = `k${md5(b.account).slice(0, 6)}-s3cr3t${Math.floor(Math.random() * 1000)}-zz9-2`;
        this.preAuth.set(b.account, t);
        return ok({ token: t });
      }
      case '/user/mail/validcode/send': {
        const t = this.preAuth.get(b.email);
        const rc = this.randomCodes.get(b.email);
        if (!t || b.token !== t) return fail('E1761', 'bad pre-auth token');
        if (!rc || b.timestamp !== rc.timestamp) return fail('E0018', 'timestamp mismatch');
        const secret = t.split('-')[Number(t.at(-1))]!;
        if (b.sign !== sha256(b.email + secret)) return fail('E1762', 'bad sign');
        const key = `vck-${Math.random().toString(36).slice(2)}`;
        this.validCodeKeys.set(key, b.email);
        return ok({ validCodeKey: key });
      }
      case '/official/user/sms/login': {
        if (this.validCodeKeys.get(b.validCodeKey) !== b.email) return fail('E1763', 'bad key');
        if (b.validCode !== this.emailCode) return fail('E1764', 'wrong code');
        if (b.equipment !== '4') return fail('422', 'Request Parameter Serialisation Exception');
        return ok({ token: this.issueToken() });
      }
    }

    // --- everything else needs a session -----------------------------------
    const token = headers['x-access-token'];
    if (!token || !this.validTokens.has(token)) {
      return this.opts.expiredStyle === 'http401' ? json({ error: 'Unauthorized' }, 401) : fail('E0401', 'Login expired');
    }

    switch (path) {
      case '/file/list/query': {
        const dir = String(b.directoryId);
        if (b.pageSize > 100) return fail('E0500', 'pageSize too large');
        const all = this.children(dir).sort((x, y) => (BigInt(y.id) > BigInt(x.id) ? 1 : -1));
        const page = all.slice((b.pageNo - 1) * b.pageSize, b.pageNo * b.pageSize);
        return ok({
          total: all.length,
          userFileVOList: page.map(({ bytes, ...n }) => ({ ...n, createTime: 0, updateTime: 0 })),
        });
      }
      case '/file/folder/add': {
        const dir = String(b.directoryId);
        if (dir !== '0' && !this.nodes.get(dir)) return fail('E0404', 'no such folder');
        if (this.children(dir).some((n) => n.isFolder === 'Y' && n.fileName === b.fileName)) return fail('E0405', 'already exists');
        this.addFolder(dir, b.fileName);
        return ok({});
      }
      case '/file/upload/apply': {
        const dir = String(b.directoryId);
        if (dir === '0') return fail('E0402', 'Cannot be operated from the root directory!');
        if (!this.nodes.get(dir)) return fail('E0404', 'no such folder');
        if (!/^[0-9a-f]{32}$/.test(b.md5) || typeof b.size !== 'number') return fail('422', 'bad apply');
        const innerName = `${md5(b.fileName + ++this.uploadCounter)}.epub`;
        const authorization = `AWS4-HMAC-SHA256 Credential=FAKEACCESSKEY/20261008/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${md5(innerName)}`;
        const xamzDate = '20261008T120000Z';
        this.uploads.set(innerName, { directoryId: dir, fileName: b.fileName, md5: b.md5, size: b.size, authorization, xamzDate });
        return ok({
          url: `${S3}/user-1234/${innerName}?x-id=PutObject`,
          s3Authorization: authorization,
          xamzDate,
          ...(this.opts.innerNameInApply ? { innerName } : {}),
        });
      }
      case '/file/upload/finish': {
        const u = this.uploads.get(b.innerName);
        if (!u) return fail('E0410', 'unknown innerName');
        if (!u.bytes) return fail('E0411', 'object not found in storage');
        if (String(b.directoryId) !== u.directoryId || b.fileName !== u.fileName) return fail('E0412', 'finish does not match apply');
        if (b.md5 !== u.md5 || b.md5 !== md5(u.bytes)) return fail('E0413', 'md5 mismatch');
        if (b.fileSize !== u.size || b.fileSize !== u.bytes.byteLength) return fail('E0414', 'size mismatch');
        this.uploads.delete(b.innerName);
        // Unknown in the real service; the fake auto-renames so silent duplicates show up in tests.
        let name = u.fileName;
        for (let i = 1; this.children(u.directoryId).some((n) => n.fileName === name); i++) {
          name = u.fileName.replace(/(\.[^.]+)?$/, `(${i})$1`);
        }
        this.addFile(u.directoryId, name, u.bytes);
        return ok({});
      }
      case '/file/delete': {
        const dir = String(b.directoryId);
        if (!Array.isArray(b.idList) || !b.idList.length) return fail('422', 'idList required');
        for (const id of b.idList) {
          const n = this.nodes.get(String(id));
          if (!n || n.directoryId !== dir) return fail('E0415', 'file not in that directory');
        }
        for (const id of b.idList) this.nodes.delete(String(id));
        return ok({});
      }
    }
    return json({ error: 'Not Found' }, 404);
  }

  private s3(method: string, url: string, headers: Record<string, string>, body: any): Response {
    this.s3Puts.push({ url, headers });
    if (method !== 'PUT') return new Response('<Error><Code>MethodNotAllowed</Code></Error>', { status: 405 });
    const innerName = new URL(url).pathname.split('/').pop()!;
    const u = this.uploads.get(innerName);
    if (!u) return new Response('<Error><Code>NoSuchUpload</Code></Error>', { status: 404 });
    if (headers['x-access-token']) return new Response('<Error><Code>InvalidArgument</Code></Error>', { status: 400 });
    if (headers['authorization'] !== u.authorization || headers['x-amz-date'] !== u.xamzDate || headers['x-amz-content-sha256'] !== 'UNSIGNED-PAYLOAD') {
      return new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 });
    }
    if (!(body instanceof Uint8Array)) return new Response('<Error><Code>BadBody</Code></Error>', { status: 400 });
    u.bytes = new Uint8Array(body);
    return new Response('', { status: 200, headers: { ETag: `"${md5(u.bytes)}"` } });
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function ok(payload: object) {
  return json({ success: true, errorCode: null, errorMsg: null, ...payload });
}
function fail(errorCode: string, errorMsg: string) {
  return json({ success: false, errorCode, errorMsg });
}
