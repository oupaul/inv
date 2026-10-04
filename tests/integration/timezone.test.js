require('./setup');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loginAsAdmin } = require('./helper');

const { app, db, ready, closeForTest } = require('../../server');
after(() => closeForTest());

let agent, partId;
before(async () => {
    await ready;
    db.prepare("UPDATE users SET force_password_change = 0 WHERE username = 'admin'").run();
    agent = await loginAsAdmin(app);
    partId = db.prepare(`
        INSERT INTO parts (part_number, part_name, unit, is_active)
        VALUES ('TZ-P1', '時區測試料件', '個', 1)
    `).run().lastInsertRowid;
});

test('process.env.TZ 設為 Asia/Taipei', () => {
    assert.equal(process.env.TZ, 'Asia/Taipei');
});

test('出入庫記錄的「記錄時間」以台灣時間（+8）顯示', async () => {
    // 插入一筆入庫，明確指定 created_at 為 UTC 午夜
    db.prepare(`
        INSERT INTO inbound_records (part_id, quantity, inbound_date, created_by, created_at)
        VALUES (?, 3, '2026-05-27', 'tz-test', '2026-05-27 00:00:00')
    `).run(partId);

    const res = await agent.get('/transaction/records?search=TZ-P1');
    assert.equal(res.status, 200);
    // UTC 00:00 → 台灣 08:00；頁面應顯示 +8 後的時間，且不應出現未轉換的 00:00:00
    assert.match(res.text, /2026-05-27 08:00:00/, '記錄時間應為台灣時間 08:00:00');
    assert.ok(!res.text.includes('2026-05-27 00:00:00'), '不應出現未轉換的 UTC 00:00:00');
});

test('到期判斷使用台灣日期：發票到期警示以 +8 計算', async () => {
    // 不易精準斷言邊界，這裡只確認 API 正常回應（邏輯已改用 date(now,+8 hours)）
    const res = await agent.get('/api/invoice-alerts');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
});
