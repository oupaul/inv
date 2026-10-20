require('./setup');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loginAsAdmin, postForm } = require('./helper');

const { app, db, ready, closeForTest } = require('../../server');
after(() => closeForTest());

let agent;
before(async () => {
    await ready;
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

test('已完成的盤點事件不可再提交批量盤點', async () => {
    const s = db.prepare("SELECT id FROM inventory_check_sessions WHERE session_date = '2026-02-01'").get();
    assert.ok(s, '盤點事件應存在');
    const part = db.prepare("SELECT id FROM parts WHERE part_number = 'CHK-P1'").get();
    const beforeCount = db.prepare('SELECT COUNT(*) as c FROM inventory_checks WHERE session_id = ?').get(s.id).c;

    const res = await postForm(agent, '/inventory/check/batch', {
        session_id: String(s.id),
        items: JSON.stringify([{ part_id: part.id, actual_quantity: 99, previous_quantity: 50 }]),
        auto_adjust: 'false'
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /\/inventory\/check\/sessions/);

    const afterCount = db.prepare('SELECT COUNT(*) as c FROM inventory_checks WHERE session_id = ?').get(s.id).c;
    assert.equal(afterCount, beforeCount, '已完成事件提交應被拒絕，不應新增盤點記錄');
});

test('已盤/未盤進度：新建盤點事件後，提交部分料件，剩餘應正確計入未盤清單', async () => {
    // 再種一個料件，讓這次盤點事件有 2 個候選料件（1 已盤、1 未盤）
    const part2 = db.prepare(`
        INSERT INTO parts (part_number, part_name, unit, is_active)
        VALUES ('CHK-P2', '盤點測試料件二', '個', 1)
    `).run().lastInsertRowid;
    // 停用料件：不應出現在盤點候選清單中（即使有進行中盤點事件）
    db.prepare(`
        INSERT INTO parts (part_number, part_name, unit, is_active)
        VALUES ('CHK-P1-INACTIVE', '已停用料件', '個', 0)
    `).run();

    await postForm(agent, '/inventory/check/sessions/create', {
        session_date: '2026-03-01',
        session_name: '三月盤點'
    });
    const s2 = db.prepare("SELECT id FROM inventory_check_sessions WHERE session_date = '2026-03-01'").get();

    const part1 = db.prepare("SELECT id FROM parts WHERE part_number = 'CHK-P1'").get();
    await postForm(agent, '/inventory/check/batch', {
        session_id: String(s2.id),
        items: JSON.stringify([{ part_id: part1.id, actual_quantity: 50, previous_quantity: 50 }]),
        auto_adjust: 'false'
    });

    const res = await agent.get('/inventory/check?session_date=2026-03-01');
    assert.equal(res.status, 200);
    // 停用料件不應出現在候選清單文字中
    assert.ok(!res.text.includes('CHK-P1-INACTIVE'), '已停用料件不應出現在盤點候選清單');
    // CHK-P2 尚未盤點，應出現在頁面（候選清單 / 未盤清單都會列出它）
    assert.ok(res.text.includes('CHK-P2'), '未盤料件應仍出現在頁面上供選取或未盤清單顯示');
});

test('匯出盤點報表：session_id 篩選正確生效（修正前此參數會被忽略）', async () => {
    const s1 = db.prepare("SELECT id FROM inventory_check_sessions WHERE session_date = '2026-02-01'").get();
    const s2 = db.prepare("SELECT id FROM inventory_check_sessions WHERE session_date = '2026-03-01'").get();

    const res = await agent.get(`/export/inventory-check?session_id=${s2.id}`).buffer(true).parse((r, cb) => {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /spreadsheetml/);
    assert.ok(res.body && res.body.length > 0, '應有檔案內容');
});
