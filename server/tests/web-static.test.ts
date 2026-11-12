import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
import { mountWeb, webFile } from '../src/webStatic';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glitch-web-'));
fs.writeFileSync(path.join(root, 'index.html'), '<h1>GLITCH</h1>');
fs.writeFileSync(path.join(root, 'admin.html'), '<h1>ADMIN</h1>');
fs.writeFileSync(path.join(root, 'advertise.html'), '<h1>ADVERTISE</h1>');
fs.mkdirSync(path.join(root, 'assets'));
fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log("city")');

const app = new Hono();
app.get('/health', (c) => c.json({ ok: true }));
mountWeb(app, root);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('web static', () => {
  it('maps the city pages onto the built html files', () => {
    expect(webFile('/')).toBe('index.html');
    expect(webFile('/admin')).toBe('admin.html');
    expect(webFile('/advertise/')).toBe('advertise.html');
    expect(webFile('/assets/app.js')).toBe('assets/app.js');
  });

  it('serves the city, the extra pages, and assets without swallowing the API', async () => {
    const health = await app.request('/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const home = await app.request('/');
    expect(home.status).toBe(200);
    expect(home.headers.get('content-type')).toContain('text/html');
    expect(await home.text()).toContain('GLITCH');

    const admin = await app.request('/admin');
    expect(await admin.text()).toContain('ADMIN');

    const ads = await app.request('/advertise');
    expect(await ads.text()).toContain('ADVERTISE');

    const asset = await app.request('/assets/app.js');
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect(await asset.text()).toContain('city');
  });
});
