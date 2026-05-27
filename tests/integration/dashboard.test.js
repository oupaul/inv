require('./setup');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loginAsAdmin } = require('./helper');

const { app, db, closeForTest } = require('../../server');
after(() => closeForTest());

let agent, steelCatId, steelPartId;
before(async () => {
    db.prepare("UPDATE users SET force_password_change = 0 WHERE username = 'admin'").run();
    agent = await loginAsAdmin(app);

    // 兩個類別、各一料件
    steelCatId = db.prepare("INSERT INTO categories (name) VALUES ('鋼品')").run().lastInsertRowid;
    const plasticCatId = db.prepare("INSERT INTO categories (name) VALUES ('塑膠')").run().lastInsertRowid;

    steelPartId = db.prepare(`
        INSERT INTO parts (part_number, part_name, unit, category_id, is_active)
        VALUES ('STEEL-1', '鋼板', '片', ?, 1)
    `).run(steelCatId).lastInsertRowid;
    const plasticPartId = db.prepare(`
        INSERT INTO parts (part_number, part_name, unit, category_id, is_active)
        VALUES ('PLASTIC-1', '塑膠板', '片', ?, 1)
    `).run(plasticCatId).lastInsertRowid;

    // 各自一筆入庫
    db.prepare("INSERT INTO inbound_records (part_id, quantity, inbound_date) VALUES (?, 10, '2026-05-27')").run(steelPartId);
    db.prepare("INSERT INTO inbound_records (part_id, quantity, inbound_date) VALUES (?, 20, '2026-05-27')").run(plasticPartId);
});

test('儀表板首頁回 200', async () => {
    const res = await agent.get('/');
    assert.equal(res.status, 200);
});

test('近期記錄顯示單據號碼（IN- 前綴）', async () => {
    const res = await agent.get('/');
    assert.match(res.text, /IN-\d+/, '近期記錄應出現 IN-xxx 單據號碼');
});

test('近期記錄連動類別篩選：篩鋼品只見鋼品記錄', async () => {
    const res = await agent.get(`/?category_id=${steelCatId}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /STEEL-1/, '應包含鋼品料件');
    assert.ok(!res.text.includes('PLASTIC-1'), '篩鋼品時不應出現塑膠料件記錄');
});

test('近期記錄依時間排序（同日多筆以 created_at 為次序，最新在前）', async () => {
    // 同一天兩筆鋼品入庫，第二筆 created_at 較晚 → 應排在前面
    db.prepare("INSERT INTO inbound_records (part_id, quantity, inbound_date, note, created_at) VALUES (?, 1, '2026-05-27', 'older', '2026-05-27 09:00:00')").run(steelPartId);
    db.prepare("INSERT INTO inbound_records (part_id, quantity, inbound_date, note, created_at) VALUES (?, 1, '2026-05-27', 'newer', '2026-05-27 18:00:00')").run(steelPartId);

    const ids = db.prepare("SELECT id, note FROM inbound_records WHERE note IN ('older','newer') ORDER BY id").all();
    const olderId = ids.find(r => r.note === 'older').id;
    const newerId = ids.find(r => r.note === 'newer').id;

    const res = await agent.get(`/?category_id=${steelCatId}`);
    const posNewer = res.text.indexOf(`IN-${newerId}`);
    const posOlder = res.text.indexOf(`IN-${olderId}`);
    assert.ok(posNewer !== -1 && posOlder !== -1, '兩筆單據都應出現');
    assert.ok(posNewer < posOlder, '較晚登錄（created_at 較新）的單據應排在較前面');
});
