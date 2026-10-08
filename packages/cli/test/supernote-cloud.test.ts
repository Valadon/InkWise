import { describe, expect, it } from 'vitest';
import {
  SupernoteCloudClient,
  SupernoteCloudError,
  SupernoteCloudOutput,
  jwtExpiresIn,
  md5Hex,
  sha256Hex,
} from '../src/adapters/supernote-cloud.js';
import { CLOUD, FakeSupernoteCloud, VIEWER, fakeJwt, type FakeOptions } from './fakes/supernote-cloud.js';

const bytes = (s: string) => new TextEncoder().encode(s);

function setup(opts: FakeOptions = {}, path?: string[]) {
  const server = new FakeSupernoteCloud(opts);
  const token = server.issueToken();
  const client = new SupernoteCloudClient(token, server.fetch);
  const output = new SupernoteCloudOutput(client, path, server.fetch);
  return { server, token, client, output };
}

describe('hash helpers', () => {
  it('md5Hex and sha256Hex give lowercase hex digests', () => {
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex(bytes('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('jwtExpiresIn', () => {
  const now = Date.UTC(2026, 9, 8, 12, 0, 0);
  it('returns seconds until exp', () => {
    expect(jwtExpiresIn(fakeJwt({ exp: now / 1000 + 3600 }), now)).toBe(3600);
  });
  it('is negative for an expired token', () => {
    expect(jwtExpiresIn(fakeJwt({ exp: now / 1000 - 60 }), now)).toBe(-60);
  });
  it('handles base64url payloads that need - and _ and no padding', () => {
    // '?>' style bytes produce '-'/'_' in base64url; the name field forces them in.
    const t = fakeJwt({ exp: now / 1000 + 10, name: '~~~???>>>ÿ' });
    expect(t.split('.')[1]).toMatch(/[-_]/);
    expect(jwtExpiresIn(t, now)).toBe(10);
  });
  it('returns null when there is no exp or the token is not a JWT', () => {
    expect(jwtExpiresIn(fakeJwt({ userId: 1 }), now)).toBeNull();
    expect(jwtExpiresIn('not-a-jwt', now)).toBeNull();
    expect(jwtExpiresIn('a.%%%.c', now)).toBeNull();
    expect(jwtExpiresIn('', now)).toBeNull();
  });
});

describe('SupernoteCloudClient login', () => {
  it('logs in with sha256(md5(password) + randomCode) and returns the token', async () => {
    const server = new FakeSupernoteCloud();
    const client = new SupernoteCloudClient(undefined, server.fetch);
    const r = await client.startLogin(server.account, server.password);
    expect(r.kind).toBe('token');
    if (r.kind !== 'token') return;
    expect(server.validTokens.has(r.token)).toBe(true);

    const [rc] = server.callsTo('/official/user/query/random/code');
    expect(rc!.body).toEqual({ countryCode: '1', account: server.account });
    const [login] = server.callsTo('/official/user/account/login/new');
    expect(login!.body).toMatchObject({ countryCode: 1, account: server.account, equipment: '1', loginMethod: '1', language: 'en' });
    expect(login!.body.password).toMatch(/^[0-9a-f]{64}$/);
    // Login calls never carry a session token, and the password itself never travels.
    for (const c of server.calls) {
      expect(c.headers['x-access-token']).toBeUndefined();
      expect(JSON.stringify(c.body ?? '')).not.toContain(server.password);
    }
  });

  it('reports a wrong password with the server message', async () => {
    const server = new FakeSupernoteCloud();
    const client = new SupernoteCloudClient(undefined, server.fetch);
    const err = await client.startLogin(server.account, 'wrong password').catch((e) => e);
    expect(err).toBeInstanceOf(SupernoteCloudError);
    expect(err.message).toContain('Incorrect account or password');
    expect(err.code).toBe('E0019');
    expect(err.authExpired).toBe(false);
  });

  it('runs the E1760 email-code flow (pre-auth sign, then sms/login)', async () => {
    const server = new FakeSupernoteCloud({ requireVerification: true });
    const client = new SupernoteCloudClient(undefined, server.fetch);
    const r = await client.startLogin(server.account, server.password);
    expect(r.kind).toBe('verify');
    if (r.kind !== 'verify') return;
    expect(r.validCodeKey).toMatch(/^vck-/);

    const [rc] = server.callsTo('/official/user/query/random/code');
    const [send] = server.callsTo('/user/mail/validcode/send');
    expect(send!.body.timestamp).toBe(r.timestamp);
    expect(r.timestamp).toBeTypeOf('number');
    expect(rc).toBeDefined();

    // User types the code sloppily: lower case, a space and a dash.
    const token = await client.finishLogin(server.account, ' ab1-2 cd ', r);
    expect(server.validTokens.has(token)).toBe(true);
    const [sms] = server.callsTo('/official/user/sms/login');
    expect(sms!.body).toMatchObject({ email: server.account, validCode: 'AB12CD', equipment: '4', timestamp: r.timestamp });
  });

  it('rejects a wrong email code', async () => {
    const server = new FakeSupernoteCloud({ requireVerification: true });
    const client = new SupernoteCloudClient(undefined, server.fetch);
    const r = await client.startLogin(server.account, server.password);
    if (r.kind !== 'verify') throw new Error('expected verify');
    await expect(client.finishLogin(server.account, 'ZZZZZZ', r)).rejects.toThrow(/wrong code/);
  });
});

describe('SupernoteCloudClient transport', () => {
  it('refuses authenticated calls without a token', async () => {
    const server = new FakeSupernoteCloud();
    const client = new SupernoteCloudClient(undefined, server.fetch);
    const err = await client.listAll('0').catch((e) => e);
    expect(err).toBeInstanceOf(SupernoteCloudError);
    expect(err.authExpired).toBe(true);
    expect(server.calls).toHaveLength(0);
  });

  it('turns HTTP 200 + E0401 into an authExpired error', async () => {
    const server = new FakeSupernoteCloud();
    const client = new SupernoteCloudClient('stale-token', server.fetch);
    const err = await client.listAll('0').catch((e) => e);
    expect(err).toBeInstanceOf(SupernoteCloudError);
    expect(err.authExpired).toBe(true);
    expect(err.code).toBe('E0401');
    expect(err.message).toMatch(/supernote-login/);
  });

  it('turns HTTP 401 into an authExpired error', async () => {
    const server = new FakeSupernoteCloud({ expiredStyle: 'http401' });
    const client = new SupernoteCloudClient('stale-token', server.fetch);
    await expect(client.listAll('0')).rejects.toMatchObject({ authExpired: true });
  });

  it('a stale session surfaces as authExpired through the output adapter too', async () => {
    const server = new FakeSupernoteCloud();
    const output = new SupernoteCloudOutput(new SupernoteCloudClient('stale-token', server.fetch), undefined, server.fetch);
    await expect(output.list()).rejects.toMatchObject({ authExpired: true });
    await expect(output.put('a.epub', bytes('x'))).rejects.toMatchObject({ authExpired: true });
  });

  it('sends the session token as x-access-token (no Bearer) with a JSON POST', async () => {
    const { server, token, client } = setup();
    await client.listAll('0');
    const [c] = server.callsTo('/file/list/query');
    expect(c!.method).toBe('POST');
    expect(c!.headers['x-access-token']).toBe(token);
    expect(c!.headers['content-type']).toBe('application/json');
    expect(c!.body).toEqual({ directoryId: 0, pageNo: 1, pageSize: 100, order: 'time', sequence: 'desc' });
  });

  it('fetches a CSRF token from GET /csrf on CSRF_TOKEN_EXPIRED and sends it as X-XSRF-TOKEN', async () => {
    const { server, client } = setup({ csrf: 'required' });
    const items = await client.listAll('0');
    expect(items.map((i) => i.fileName)).toContain('Document');
    expect(client.base).toBe(CLOUD);
    const hosts = server.calls.map((c) => `${c.method} ${c.host}${c.path}`);
    expect(hosts).toEqual(['POST cloud/file/list/query', 'GET cloud/csrf', 'POST cloud/file/list/query']);
    expect(server.calls[2]!.headers['x-xsrf-token']).toBe(server.csrfToken);
    // The token is kept for later calls: no second CSRF round trip.
    await client.listAll('0');
    expect(server.callsTo('/csrf')).toHaveLength(1);
    expect(server.calls.at(-1)!.headers['x-xsrf-token']).toBe(server.csrfToken);
  });

  it('falls back to viewer.supernote.com when the cloud host keeps failing CSRF', async () => {
    const { server, client, output } = setup({ csrf: 'cloud-broken' });
    await output.put('Fallback.epub', bytes('epub bytes'));
    expect(client.base).toBe(VIEWER);
    const cloudCalls = server.calls.filter((c) => c.host === 'cloud');
    // One failed call, one CSRF refresh, one retry; then everything goes to the viewer host.
    expect(cloudCalls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /file/list/query', 'GET /csrf', 'POST /file/list/query']);
    expect(server.calls.filter((c) => c.host === 'viewer').length).toBeGreaterThan(3);
    // The cloud host's CSRF token is not sent to the viewer host.
    for (const c of server.calls.filter((c) => c.host === 'viewer')) expect(c.headers['x-xsrf-token']).toBeUndefined();
    expect(server.children(server.findPath(['Document', 'Inkwise'])!.id).map((n) => n.fileName)).toEqual(['Fallback.epub']);
  });

  it('login also falls back to the viewer host', async () => {
    const server = new FakeSupernoteCloud({ csrf: 'cloud-broken' });
    const client = new SupernoteCloudClient(undefined, server.fetch);
    const r = await client.startLogin(server.account, server.password);
    expect(r.kind).toBe('token');
    expect(server.callsTo('/official/user/account/login/new')[0]!.host).toBe('viewer');
  });

  it('gives up with a clear error when every host fails CSRF', async () => {
    const server = new FakeSupernoteCloud({ csrf: 'cloud-broken' });
    const client = new SupernoteCloudClient(server.issueToken(), server.fetch, [CLOUD]);
    const err = await client.listAll('0').catch((e) => e);
    expect(err).toBeInstanceOf(SupernoteCloudError);
    expect(err.message).toMatch(/CSRF/);
    expect(err.authExpired).toBe(false);
  });

  it('paginates /file/list/query past 100 entries', async () => {
    const { server, client } = setup();
    const dir = server.addFolder('0', 'Big');
    for (let i = 0; i < 250; i++) server.addFile(dir.id, `f${i}.epub`, bytes(`file ${i}`));
    const items = await client.listAll(dir.id);
    expect(items).toHaveLength(250);
    expect(new Set(items.map((i) => i.fileName)).size).toBe(250);
    const pages = server.callsTo('/file/list/query').map((c) => c.body.pageNo);
    expect(pages).toEqual([1, 2, 3]);
    // Non-root ids are passed through as strings (they are too large for a JS number).
    expect(server.callsTo('/file/list/query')[0]!.body.directoryId).toBe(dir.id);
  });

  it('stops after exactly 100 entries without asking for an empty page', async () => {
    const { server, client } = setup();
    const dir = server.addFolder('0', 'Hundred');
    for (let i = 0; i < 100; i++) server.addFile(dir.id, `f${i}.epub`, bytes('x'));
    expect(await client.listAll(dir.id)).toHaveLength(100);
    expect(server.callsTo('/file/list/query')).toHaveLength(1);
  });
});

describe('SupernoteCloudClient.ensurePath', () => {
  it('creates Document/Inkwise when Inkwise is missing', async () => {
    const { server, client } = setup();
    const doc = server.findPath(['Document'])!;
    const id = await client.ensurePath(['Document', 'Inkwise'], true);
    const inkwise = server.findPath(['Document', 'Inkwise'])!;
    expect(id).toBe(inkwise.id);
    expect(inkwise.directoryId).toBe(doc.id);
    expect(server.callsTo('/file/folder/add').map((c) => c.body)).toEqual([{ directoryId: doc.id, fileName: 'Inkwise' }]);
  });

  it('creates a missing top-level folder with directoryId 0 (a number)', async () => {
    const { server, client } = setup();
    const id = await client.ensurePath(['Books', 'Inkwise'], true);
    expect(id).toBe(server.findPath(['Books', 'Inkwise'])!.id);
    expect(server.callsTo('/file/folder/add')[0]!.body).toEqual({ directoryId: 0, fileName: 'Books' });
  });

  it('finds Document case-insensitively and does not create a duplicate', async () => {
    const { server, client } = setup({ documentFolderName: 'document' });
    const existing = server.addFolder(server.findPath(['document'])!.id, 'inkwise');
    expect(await client.ensurePath(['Document', 'Inkwise'], true)).toBe(existing.id);
    expect(server.callsTo('/file/folder/add')).toHaveLength(0);
  });

  it('ignores files that share the folder name', async () => {
    const { server, client } = setup();
    const doc = server.findPath(['Document'])!;
    server.addFile(doc.id, 'Inkwise', bytes('not a folder'));
    const id = await client.ensurePath(['Document', 'Inkwise'], true);
    expect(server.nodes.get(id!)!.isFolder).toBe('Y');
  });

  it('returns null without creating anything when create is false', async () => {
    const { server, client } = setup();
    expect(await client.ensurePath(['Document', 'Inkwise'], false)).toBeNull();
    expect(server.callsTo('/file/folder/add')).toHaveLength(0);
  });

  it('returns the root id for an empty path', async () => {
    const { client } = setup();
    expect(await client.ensurePath([], true)).toBe('0');
  });
});

describe('SupernoteCloudOutput', () => {
  it('list() is empty and creates nothing when the folder does not exist yet', async () => {
    const { server, output } = setup();
    expect(await output.list()).toEqual([]);
    expect(server.callsTo('/file/folder/add')).toHaveLength(0);
  });

  it('put() creates the folder and uploads via apply -> S3 PUT -> finish', async () => {
    const { server, token, output } = setup();
    const data = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x80, 0x7f]);
    await output.put('Hello World.epub', data);

    const inkwise = server.findPath(['Document', 'Inkwise'])!;
    const [file] = server.children(inkwise.id);
    expect(file).toMatchObject({ fileName: 'Hello World.epub', size: data.byteLength, md5: md5Hex(data), isFolder: 'N' });
    expect(file!.bytes).toEqual(data);

    const order = server.calls.map((c) => (c.host === 's3' ? 'S3 PUT' : c.path)).filter((p) => p !== '/file/list/query');
    expect(order).toEqual(['/file/folder/add', '/file/upload/apply', 'S3 PUT', '/file/upload/finish']);

    const [apply] = server.callsTo('/file/upload/apply');
    expect(apply!.body).toEqual({ directoryId: inkwise.id, fileName: 'Hello World.epub', md5: md5Hex(data), size: data.byteLength });
    const s3 = server.calls.find((c) => c.host === 's3')!;
    expect(s3.method).toBe('PUT');
    expect(s3.headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(s3.headers['x-amz-date']).toBe('20261008T120000Z');
    expect(s3.headers['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
    expect(s3.headers['x-access-token']).toBeUndefined();
    const [finish] = server.callsTo('/file/upload/finish');
    expect(finish!.headers['x-access-token']).toBe(token);
    expect(finish!.body).toMatchObject({ directoryId: inkwise.id, fileName: 'Hello World.epub', fileSize: data.byteLength, md5: md5Hex(data) });

    expect(await output.list()).toEqual([{ name: 'Hello World.epub', size: data.byteLength }]);
  });

  it('takes innerName from the S3 URL path (without the query) when apply omits it', async () => {
    const { server, output } = setup({ innerNameInApply: false });
    await output.put('a.epub', bytes('abc'));
    const [finish] = server.callsTo('/file/upload/finish');
    expect(finish!.body.innerName).toMatch(/^[0-9a-f]{32}\.epub$/);
    expect(server.children(server.findPath(['Document', 'Inkwise'])!.id).map((n) => n.fileName)).toEqual(['a.epub']);
  });

  it('put() replaces an existing same-named file (delete, then upload) after list()', async () => {
    const { server, output } = setup();
    const dir = server.addFolder(server.findPath(['Document'])!.id, 'Inkwise');
    const old = server.addFile(dir.id, 'Article.epub', bytes('old version'));
    server.addFile(dir.id, 'Other.epub', bytes('keep me'));

    expect((await output.list()).map((f) => f.name).sort()).toEqual(['Article.epub', 'Other.epub']);
    await output.put('Article.epub', bytes('new version!'));

    expect(server.callsTo('/file/delete').map((c) => c.body)).toEqual([{ directoryId: dir.id, idList: [old.id] }]);
    const del = server.calls.findIndex((c) => c.path === '/file/delete');
    const apply = server.calls.findIndex((c) => c.path === '/file/upload/apply');
    expect(del).toBeLessThan(apply);
    const files = server.children(dir.id);
    expect(files.map((f) => f.fileName).sort()).toEqual(['Article.epub', 'Other.epub']);
    expect(new TextDecoder().decode(files.find((f) => f.fileName === 'Article.epub')!.bytes)).toBe('new version!');
  });

  it('put() replaces an existing file even without a prior list()', async () => {
    const { server, output } = setup();
    const dir = server.addFolder(server.findPath(['Document'])!.id, 'Inkwise');
    server.addFile(dir.id, 'Article.epub', bytes('old version'));
    await output.put('Article.epub', bytes('new version!'));
    expect(server.children(dir.id).map((f) => f.fileName)).toEqual(['Article.epub']);
  });

  it('putting the same name twice in one session leaves a single file', async () => {
    const { server, output } = setup();
    await output.list();
    await output.put('Twice.epub', bytes('first'));
    await output.put('Twice.epub', bytes('second'));
    const dir = server.findPath(['Document', 'Inkwise'])!;
    const files = server.children(dir.id);
    expect(files.map((f) => f.fileName)).toEqual(['Twice.epub']);
    expect(new TextDecoder().decode(files[0]!.bytes)).toBe('second');
  });

  it('remove() deletes by id and ignores unknown names', async () => {
    const { server, output } = setup();
    const dir = server.addFolder(server.findPath(['Document'])!.id, 'Inkwise');
    const gone = server.addFile(dir.id, 'Gone.epub', bytes('bye'));
    server.addFile(dir.id, 'Stay.epub', bytes('hi'));

    await output.remove('Gone.epub');
    expect(server.callsTo('/file/delete').map((c) => c.body)).toEqual([{ directoryId: dir.id, idList: [gone.id] }]);
    await output.remove('Never-existed.epub');
    expect(server.callsTo('/file/delete')).toHaveLength(1);
    expect(server.children(dir.id).map((f) => f.fileName)).toEqual(['Stay.epub']);
  });

  it('remove() can delete a file uploaded earlier in the same session', async () => {
    const { server, output } = setup();
    await output.list();
    await output.put('Old-Name.epub', bytes('a'));
    await output.put('New-Name.epub', bytes('b'));
    await output.remove('Old-Name.epub');
    expect(server.children(server.findPath(['Document', 'Inkwise'])!.id).map((f) => f.fileName)).toEqual(['New-Name.epub']);
  });

  it('remove() is a no-op when the folder does not exist', async () => {
    const { server, output } = setup();
    await output.remove('x.epub');
    expect(server.callsTo('/file/delete')).toHaveLength(0);
    expect(server.callsTo('/file/folder/add')).toHaveLength(0);
  });

  it('list() hides subfolders such as Archive', async () => {
    const { server, output } = setup();
    const dir = server.addFolder(server.findPath(['Document'])!.id, 'Inkwise');
    server.addFolder(dir.id, 'Archive');
    server.addFile(dir.id, 'One.epub', bytes('12345'));
    expect(await output.list()).toEqual([{ name: 'One.epub', size: 5 }]);
  });

  it('list() pages through a folder with more than 100 files', async () => {
    const { server, output } = setup();
    const dir = server.addFolder(server.findPath(['Document'])!.id, 'Inkwise');
    for (let i = 0; i < 205; i++) server.addFile(dir.id, `doc-${i}.epub`, bytes('x'));
    expect(await output.list()).toHaveLength(205);
  });

  it('uses a custom folder path', async () => {
    const { server, output } = setup({}, ['Document', 'Reading', 'Queue']);
    await output.put('q.epub', bytes('q'));
    expect(server.findPath(['Document', 'Reading', 'Queue'])).toBeDefined();
  });

  it('uploading to the root directory is rejected by the server and reported', async () => {
    const { server, output } = setup({}, []);
    const err = await output.put('root.epub', bytes('x')).catch((e) => e);
    expect(err).toBeInstanceOf(SupernoteCloudError);
    expect(err.message).toMatch(/root directory/);
    expect(err.authExpired).toBe(false);
    expect(server.calls.some((c) => c.host === 's3')).toBe(false);
  });

  it('fails clearly when the S3 PUT is rejected, without calling finish', async () => {
    const server = new FakeSupernoteCloud();
    const client = new SupernoteCloudClient(server.issueToken(), server.fetch);
    const tamper: typeof fetch = (input, init: any) => {
      if (String(input).includes('amazonaws.com')) init = { ...init, headers: { ...init.headers, 'x-amz-date': '19700101T000000Z' } };
      return server.fetch(input, init);
    };
    const output = new SupernoteCloudOutput(client, undefined, tamper);
    await expect(output.put('a.epub', bytes('a'))).rejects.toThrow(/storage upload failed \(HTTP 403\)/);
    expect(server.callsTo('/file/upload/finish')).toHaveLength(0);
  });

  it('works with CSRF required on the cloud host', async () => {
    const { server, client, output } = setup({ csrf: 'required' });
    await output.list();
    await output.put('csrf.epub', bytes('c'));
    await output.remove('csrf.epub');
    expect(client.base).toBe(CLOUD);
    expect(server.callsTo('/csrf')).toHaveLength(1);
    expect(server.children(server.findPath(['Document', 'Inkwise'])!.id)).toHaveLength(0);
  });
});
