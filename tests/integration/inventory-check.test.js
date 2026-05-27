require('./setup');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loginAsAdmin, postForm } = require('./helper');

const { app, db, closeForTest } = require('../../server');
after(() => closeForTest());

let agent;
before(async () => {
    db.prepare("UPDATE users SET force_password_change = 0 WHERE username = 'admin'").run();
    agent = await loginAsAdmin(app);
    // 種一個有庫存的料件
    const partId = db.prepare(`
        INSERT INTO parts (part_number, part_name, unit, min_stock, is_active)
        VALUES ('CHK-P1', '盤點測試料件', '個', 0, 1)
    `).run().lastInsertRowid;
    db.prepare(`INSERT INTO inbound_records (part_id, quantity, inbound_date) VALUES (?, 50, '2026-01-01')`).run(partId);
});

test('GET /inventory/check/sessions 回 200', async () => {
    const res = await agent.get('/inventory/check/sessions');
    assert.equal(res.status, 200);
});

test('POST /inventory/check/sessions/create 建立盤點事件', async () => {
    const res = await postForm(agent, '/inventory/check/sessions/create', {
        session_date: '2026-02-01',
        session_name: '二月盤點',
        note: 'test'
    });
    assert.equal(res.status, 302);
    const s = db.prepare("SELECT * FROM inventory_check_sessions WHERE session_date = '2026-02-01'").get();
    assert.ok(s, '盤點事件應已建立');
    assert.equal(s.status, 'in_progress');
});

test('重複日期建立盤點事件 → 導回並不重複建立', async () => {
    const res = await postForm(agent, '/inventory/check/sessions/create', {
        session_date: '2026-02-01',
        session_name: '重複'
    });
    assert.equal(res.status, 302);
    const count = db.prepare("SELECT COUNT(*) as c FROM inventory_check_sessions WHERE session_date = '2026-02-01'").get().c;
    assert.equal(count, 1);
});

test('POST /inventory/check/sessions/:id/complete 標記完成', async () => {
    const s = db.prepare("SELECT id FROM inventory_check_sessions WHERE session_date = '2026-02-01'").get();
    const res = await postForm(agent, `/inventory/check/sessions/${s.id}/complete`, {});
    assert.equal(res.status, 302);
    const updated = db.prepare('SELECT status, completed_at FROM inventory_check_sessions WHERE id = ?').get(s.id);
    assert.equal(updated.status, 'completed');
    assert.ok(updated.completed_at);
});

test('GET /inventory/check/records 回 200', async () => {
    const res = await agent.get('/inventory/check/records');
    assert.equal(res.status, 200);
});

test('GET /inventory/check/differences 回 200', async () => {
    const res = await agent.get('/inventory/check/differences');
    assert.equal(res.status, 200);
});

test('GET /inventory/check 盤點作業頁回 200', async () => {
    const res = await agent.get('/inventory/check?session_date=2026-02-01');
    assert.equal(res.status, 200);
});
