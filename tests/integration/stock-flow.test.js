require('./setup');
const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { loginAsAdmin, postForm } = require('./helper');

const { app, db, closeForTest } = require('../../server');
after(() => closeForTest());

let agent;
before(async () => {
    // 清掉強制改密碼旗標，直接登入做庫存流程測試
    db.prepare("UPDATE users SET force_password_change = 0 WHERE username = 'admin'").run();
    agent = await loginAsAdmin(app);
});

// 在 DB 直接建立一個測試料件（繞過 UI 表單，加快測試）
function seedPart() {
    const result = db.prepare(`
        INSERT INTO parts (part_number, part_name, specification, unit, min_stock, is_active)
        VALUES (?, ?, ?, ?, ?, 1)
    `).run('TEST-001', '測試料件', '規格', '個', 0);
    return result.lastInsertRowid;
}

function getPhysicalStock(partId) {
    const row = db.prepare(`
        SELECT
            COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE part_id = ?), 0) -
            COALESCE((SELECT SUM(quantity) FROM outbound_records WHERE part_id = ?), 0) AS stock
    `).get(partId, partId);
    return row.stock;
}

test('入庫 10 → 物理庫存 = 10', async () => {
    const partId = seedPart();
    const res = await postForm(agent, '/inbound', {
        part_id: String(partId),
        quantity: '10',
        inbound_date: '2026-01-01',
        note: 'test'
    });
    assert.equal(res.status, 302);  // redirect 回首頁
    assert.equal(getPhysicalStock(partId), 10);
});

test('入庫 10 → 出庫 3 → 庫存 = 7', async () => {
    const partId = seedPart();
    await postForm(agent, '/inbound', { part_id: String(partId), quantity: '10', inbound_date: '2026-01-01' });
    await postForm(agent, '/outbound', { part_id: String(partId), quantity: '3', outbound_date: '2026-01-02' });
    assert.equal(getPhysicalStock(partId), 7);
});

test('一般出庫退回：出 3 → 退 3 → 庫存還原為 10', async () => {
    const partId = seedPart();
    await postForm(agent, '/inbound', { part_id: String(partId), quantity: '10', inbound_date: '2026-01-01' });
    await postForm(agent, '/outbound', { part_id: String(partId), quantity: '3', outbound_date: '2026-01-02' });
    // 找到那筆 outbound 的 id
    const ob = db.prepare('SELECT id FROM outbound_records WHERE part_id = ? ORDER BY id DESC LIMIT 1').get(partId);
    // 退回（is_return + return_outbound_id）
    await postForm(agent, '/inbound', {
        part_id: String(partId),
        quantity: '3',
        inbound_date: '2026-01-03',
        is_return: 'on',
        return_outbound_id: String(ob.id)
    });
    assert.equal(getPhysicalStock(partId), 10);
});

test('庫存不足時拒絕出庫', async () => {
    const partId = seedPart();
    await postForm(agent, '/inbound', { part_id: String(partId), quantity: '5', inbound_date: '2026-01-01' });
    const res = await postForm(agent, '/outbound', { part_id: String(partId), quantity: '10', outbound_date: '2026-01-02' });
    // 庫存不足 → redirect 回 /outbound（不寫入）
    assert.equal(res.status, 302);
    assert.equal(getPhysicalStock(partId), 5);  // 沒變
});

test('輸入驗證：負數量拒絕', async () => {
    const partId = seedPart();
    const res = await postForm(agent, '/inbound', { part_id: String(partId), quantity: '-5', inbound_date: '2026-01-01' });
    assert.equal(res.status, 302);  // redirect 回 /inbound
    assert.equal(getPhysicalStock(partId), 0);
});

test('輸入驗證：日期格式錯誤拒絕', async () => {
    const partId = seedPart();
    const res = await postForm(agent, '/inbound', { part_id: String(partId), quantity: '5', inbound_date: 'not-a-date' });
    assert.equal(res.status, 302);
    assert.equal(getPhysicalStock(partId), 0);
});

test('使用者回報情境：一般出庫 + 退回 重複兩次，庫存應為 0', async () => {
    const partId = seedPart();
    // 起始庫存 = 4（足夠做兩次 -2）
    await postForm(agent, '/inbound', { part_id: String(partId), quantity: '4', inbound_date: '2026-01-01' });
    assert.equal(getPhysicalStock(partId), 4);
    // 出 -2 → 退 +2 重複兩次
    for (let i = 0; i < 2; i++) {
        await postForm(agent, '/outbound', { part_id: String(partId), quantity: '2', outbound_date: '2026-01-02' });
        const ob = db.prepare('SELECT id FROM outbound_records WHERE part_id = ? ORDER BY id DESC LIMIT 1').get(partId);
        await postForm(agent, '/inbound', {
            part_id: String(partId),
            quantity: '2',
            inbound_date: '2026-01-03',
            is_return: 'on',
            return_outbound_id: String(ob.id)
        });
    }
    // 應該回到 4（原始入庫 +4，4 次相抵 = 0 變化）
    assert.equal(getPhysicalStock(partId), 4);
});

test('作廢出庫 → 反向 inbound 自動產生 → 庫存恢復', async () => {
    const partId = seedPart();
    await postForm(agent, '/inbound', { part_id: String(partId), quantity: '10', inbound_date: '2026-01-01' });
    await postForm(agent, '/outbound', { part_id: String(partId), quantity: '4', outbound_date: '2026-01-02' });
    assert.equal(getPhysicalStock(partId), 6);

    const ob = db.prepare('SELECT id FROM outbound_records WHERE part_id = ? ORDER BY id DESC LIMIT 1').get(partId);
    // 作廢
    const voidRes = await postForm(agent, `/outbound/${ob.id}/void`, { void_reason: 'test' });
    assert.equal(voidRes.status, 200);
    assert.equal(voidRes.body.success, true);
    // 物理庫存應該回到 10
    assert.equal(getPhysicalStock(partId), 10);
});
