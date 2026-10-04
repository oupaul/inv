require('./setup');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { loginAsAdmin } = require('./helper');

const { app, db, ready, closeForTest } = require('../../server');
after(() => closeForTest());

let agent;
before(async () => {
    await ready;
    // 404 測試需要已登入身分，否則未知路徑會先被全域 auth guard 導去 /login（這是預期行為，不是 bug）
    db.prepare("UPDATE users SET force_password_change = 0 WHERE username = 'admin'").run();
    agent = await loginAsAdmin(app);
});

test('GET /healthz 不需登入回 200', async () => {
    const res = await request(app).get('/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.ts);
});

test('GET /login 不需登入可訪問', async () => {
    const res = await request(app).get('/login');
    assert.equal(res.status, 200);
    assert.match(res.text, /庫存管理|登入/);
});

test('GET / 未登入 → redirect 到 /login', async () => {
    const res = await request(app).get('/');
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /\/login/);
});

test('GET /parts 未登入 → redirect 到 /login', async () => {
    const res = await request(app).get('/parts');
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /\/login/);
});

test('GET /api/barcode 未登入 → 401 JSON', async () => {
    const res = await request(app).get('/api/barcode/12345');
    assert.equal(res.status, 401);
    assert.equal(res.body.success, false);
});

test('安全 HTTP 標頭存在', async () => {
    const res = await request(app).get('/healthz');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
    assert.equal(res.headers['referrer-policy'], 'same-origin');
});

test('404 處理：未知路徑（已登入）回 404 而非 5xx', async () => {
    // 未登入打未知路徑會被全域 auth guard 導去 /login（302），要測真正的 404 handler 需先登入
    const res = await agent.get('/no-such-page');
    assert.equal(res.status, 404);
});

test('404 處理：未登入打未知路徑 → 導去 /login（auth guard 優先於 404）', async () => {
    const res = await request(app).get('/no-such-page');
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /\/login/);
});
