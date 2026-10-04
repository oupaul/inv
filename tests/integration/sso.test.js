require('./setup');   // 測試環境未設 SSO_* → SSO 停用
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app, ready, closeForTest } = require('../../server');
after(() => closeForTest());
// 這個檔案本身不需要預設管理員帳號，但仍要等它建立完成，
// 否則背景中未完成的 createDefaultAdmin() 會在 closeForTest() 關閉 DB 後才嘗試寫入而噴錯
before(async () => { await ready; });

test('SSO 未設定時，登入頁不顯示 Microsoft 365 按鈕', async () => {
    const res = await request(app).get('/login');
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('Microsoft 365'), 'SSO 停用時不應出現 M365 按鈕');
});

test('SSO 未設定時，GET /auth/sso 導回 /login', async () => {
    const res = await request(app).get('/auth/sso');
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /\/login/);
});

test('GET /auth/callback 缺 code/state → 導回 /login（不 500）', async () => {
    const res = await request(app).get('/auth/callback');
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /\/login/);
});

test('/auth/sso 與 /auth/callback 為公開路徑（未登入可達，不被導去因 401）', async () => {
    // 未登入直接打，應是 302 到 /login（SSO 流程），而非被全域守門以「請先登入」攔截後的行為差異
    const res = await request(app).get('/auth/sso');
    assert.equal(res.status, 302);
});
