require('./setup');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loginAsAdmin, postForm } = require('./helper');
const request = require('supertest');

const { app, db, closeForTest } = require('../../server');
after(() => closeForTest());

let agent, partId;
before(async () => {
    db.prepare("UPDATE users SET force_password_change = 0 WHERE username = 'admin'").run();
    agent = await loginAsAdmin(app);
    partId = db.prepare(`
        INSERT INTO parts (part_number, part_name, unit, is_active)
        VALUES ('NOTE-P1', '備註測試料件', '個', 1)
    `).run().lastInsertRowid;
});

function seedInbound(opts = {}) {
    const r = db.prepare(`
        INSERT INTO inbound_records (part_id, quantity, inbound_date, note, created_by, is_voided, is_void_reversal)
        VALUES (?, 5, '2026-05-27', ?, ?, ?, ?)
    `).run(partId, opts.note || 'old note', opts.createdBy || '系統管理員',
           opts.isVoided ? 1 : 0, opts.isVoidReversal ? 1 : 0);
    return r.lastInsertRowid;
}

test('管理員可修改任何人的備註', async () => {
    const id = seedInbound({ createdBy: '其他人', note: 'A' });
    const res = await agent.post('/inbound/' + id + '/note')
        .set('Origin', 'http://localhost')
        .set('Content-Type', 'application/json')
        .send({ note: 'B' });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    const row = db.prepare('SELECT note FROM inbound_records WHERE id = ?').get(id);
    assert.equal(row.note, 'B');
});

test('清空備註：傳空字串會把 note 設為 NULL', async () => {
    const id = seedInbound({ note: 'will be cleared' });
    const res = await agent.post('/inbound/' + id + '/note')
        .set('Origin', 'http://localhost')
        .set('Content-Type', 'application/json')
        .send({ note: '' });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    const row = db.prepare('SELECT note FROM inbound_records WHERE id = ?').get(id);
    assert.equal(row.note, null);
});

test('已作廢記錄拒絕編輯', async () => {
    const id = seedInbound({ isVoided: true });
    const res = await agent.post('/inbound/' + id + '/note')
        .set('Origin', 'http://localhost')
        .set('Content-Type', 'application/json')
        .send({ note: 'try to edit' });
    assert.equal(res.body.success, false);
    assert.match(res.body.error, /作廢/);
});

test('作廢調整記錄拒絕編輯', async () => {
    const id = seedInbound({ isVoidReversal: true });
    const res = await agent.post('/inbound/' + id + '/note')
        .set('Origin', 'http://localhost')
        .set('Content-Type', 'application/json')
        .send({ note: 'try' });
    assert.equal(res.body.success, false);
    assert.match(res.body.error, /作廢調整|不可編輯/);
});

test('備註長度超過 1000 字元拒絕', async () => {
    const id = seedInbound();
    const res = await agent.post('/inbound/' + id + '/note')
        .set('Origin', 'http://localhost')
        .set('Content-Type', 'application/json')
        .send({ note: 'x'.repeat(1001) });
    assert.equal(res.body.success, false);
    assert.match(res.body.error, /1000/);
});

test('不存在的記錄回錯誤', async () => {
    const res = await agent.post('/inbound/999999/note')
        .set('Origin', 'http://localhost')
        .set('Content-Type', 'application/json')
        .send({ note: 'x' });
    assert.equal(res.body.success, false);
    assert.match(res.body.error, /不存在/);
});

test('非建立者也非管理員 → 403', async () => {
    // 在 DB 建一個普通使用者 + 一筆「別人」建的記錄
    const argon2 = require('argon2');
    const hash = await argon2.hash('userpass1', { type: argon2.argon2id });
    db.prepare(`
        INSERT OR IGNORE INTO users (username, password_hash, full_name, email, role, is_active, force_password_change)
        VALUES ('u1', ?, '小明', null, 'user', 1, 0)
    `).run(hash);

    const id = seedInbound({ createdBy: '小王' });   // 小王建立的，小明試圖改

    const userAgent = request.agent(app);
    const loginRes = await userAgent.post('/login')
        .type('form').set('Origin', 'http://localhost')
        .send({ username: 'u1', password: 'userpass1' });
    assert.equal(loginRes.status, 302);

    const res = await userAgent.post('/inbound/' + id + '/note')
        .set('Origin', 'http://localhost')
        .set('Content-Type', 'application/json')
        .send({ note: 'I am not allowed' });
    assert.equal(res.status, 403);
    assert.equal(res.body.success, false);
});

test('建立者本人可修改自己建的備註', async () => {
    // 小明建一筆出庫記錄
    const id = db.prepare(`
        INSERT INTO outbound_records (part_id, quantity, outbound_date, note, created_by, is_loan)
        VALUES (?, 1, '2026-05-27', 'mine', '小明', 0)
    `).run(partId).lastInsertRowid;

    const userAgent = request.agent(app);
    await userAgent.post('/login')
        .type('form').set('Origin', 'http://localhost')
        .send({ username: 'u1', password: 'userpass1' });

    const res = await userAgent.post('/outbound/' + id + '/note')
        .set('Origin', 'http://localhost')
        .set('Content-Type', 'application/json')
        .send({ note: 'updated by myself' });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    const row = db.prepare('SELECT note FROM outbound_records WHERE id = ?').get(id);
    assert.equal(row.note, 'updated by myself');
});
