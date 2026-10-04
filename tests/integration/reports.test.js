require('./setup');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loginAsAdmin } = require('./helper');

const { app, db, ready, closeForTest } = require('../../server');
after(() => closeForTest());

let agent;
before(async () => {
    await ready;
    db.prepare("UPDATE users SET force_password_change = 0 WHERE username = 'admin'").run();
    agent = await loginAsAdmin(app);
    // 種一點資料讓匯出有內容
    const partId = db.prepare(`
        INSERT INTO parts (part_number, part_name, unit, min_stock, is_active)
        VALUES ('RPT-P1', '報表測試料件', '個', 5, 1)
    `).run().lastInsertRowid;
    db.prepare(`INSERT INTO inbound_records (part_id, quantity, inbound_date) VALUES (?, 30, '2026-01-01')`).run(partId);
    db.prepare(`INSERT INTO outbound_records (part_id, quantity, outbound_date, is_loan) VALUES (?, 7, '2026-01-02', 0)`).run(partId);
});

// 匯出端點應回 200 且為 Excel（非 HTML）
async function assertXlsx(res) {
    assert.equal(res.status, 200);
    const ct = res.headers['content-type'] || '';
    assert.ok(
        /spreadsheet|octet-stream|ms-excel/.test(ct),
        `content-type 應為 Excel，實際為 ${ct}`
    );
    assert.ok(res.body && res.body.length > 0, '應有檔案內容');
}

test('GET /export/parts 匯出料件 Excel', async () => {
    const res = await agent.get('/export/parts').buffer(true).parse((r, cb) => {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    await assertXlsx(res);
});

test('GET /export/inventory 匯出庫存 Excel', async () => {
    const res = await agent.get('/export/inventory').buffer(true).parse((r, cb) => {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    await assertXlsx(res);
});

test('GET /export/transaction-records 匯出出入庫 Excel', async () => {
    const res = await agent.get('/export/transaction-records').buffer(true).parse((r, cb) => {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    await assertXlsx(res);
});

test('GET /import/template 下載匯入範本 Excel', async () => {
    const res = await agent.get('/import/template').buffer(true).parse((r, cb) => {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    await assertXlsx(res);
});

test('GET /import 匯入頁面回 200', async () => {
    const res = await agent.get('/import');
    assert.equal(res.status, 200);
});
