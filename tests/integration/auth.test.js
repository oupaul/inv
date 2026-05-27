require('./setup');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { postForm, loginAsAdmin } = require('./helper');

const { app, db, closeForTest } = require('../../server');
after(() => closeForTest());

// 清掉預設 admin 的強制改密碼旗標（部分測試只想驗證 session/auth，不需走改密碼流程）
function clearForcePasswordChange() {
    db.prepare("UPDATE users SET force_password_change = 0 WHERE username = 'admin'").run();
}

test('登入：錯誤密碼 → redirect 回 /login', async () => {
    const res = await postForm(request(app), '/login', { username: 'admin', password: 'wrong-password' });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /\/login/);
});

test('登入：缺欄位 → 驗證失敗', async () => {
    const res = await postForm(request(app), '/login', { username: '', password: '' });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /\/login/);
});

test('登入：admin/admin123 → 因 force_password_change=1 redirect 到 /change-password', async () => {
    const agent = request.agent(app);
    const res = await postForm(agent, '/login', { username: 'admin', password: 'admin123' });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /\/change-password/);
});

test('Origin 檢查：缺 Origin/Referer 的 POST → 403', async () => {
    // 不帶 Origin
    const res = await request(app)
        .post('/login')
        .type('form')
        .send({ username: 'admin', password: 'admin123' });
    assert.equal(res.status, 403);
});

test('Origin 檢查：跨站 Origin → 403', async () => {
    const res = await request(app)
        .post('/login')
        .type('form')
        .set('Origin', 'http://evil.com')
        .send({ username: 'admin', password: 'admin123' });
    assert.equal(res.status, 403);
});

test('登入後 session 維持：能訪問 / 且回 200', async () => {
    clearForcePasswordChange();           // 清旗標，純測 session 存取
    const agent = await loginAsAdmin(app);
    const res = await agent.get('/');
    assert.equal(res.status, 200);
    assert.match(res.text, /庫存|料件/);
});

test('登出後 session 失效：訪問 / → redirect /login', async () => {
    clearForcePasswordChange();
    const agent = await loginAsAdmin(app);
    // /logout 在 PUBLIC_PATHS，不需 Origin
    await postForm(agent, '/logout', {});
    const res = await agent.get('/');
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /\/login/);
});

// 放在最後：此測試會把 admin 密碼改掉，避免影響其他用 admin123 登入的測試
test('強制改密碼流程：改完密碼後 DB 旗標清除且新密碼生效', async () => {
    const argon2 = require('argon2');
    const hash = await argon2.hash('admin123', { type: argon2.argon2id });
    db.prepare("UPDATE users SET password_hash = ?, force_password_change = 1 WHERE username = 'admin'").run(hash);

    const agent = await loginAsAdmin(app);   // 302 → /change-password
    const changeRes = await postForm(agent, '/change-password', {
        current_password: 'admin123',
        new_password: 'newpass123',
        confirm_password: 'newpass123'
    });
    assert.equal(changeRes.status, 302);
    assert.match(changeRes.headers.location, /\/$/);  // 改完導向首頁

    // 驗證 DB 來源真相：強制旗標已清、新密碼可驗證（不依賴 session 內標記跨請求傳播）
    const row = db.prepare("SELECT force_password_change, password_hash FROM users WHERE username = 'admin'").get();
    assert.equal(row.force_password_change, 0);
    assert.ok(await argon2.verify(row.password_hash, 'newpass123'));
});
