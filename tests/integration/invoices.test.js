require('./setup');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loginAsAdmin, postForm } = require('./helper');

const { app, db, ready, closeForTest } = require('../../server');
after(() => closeForTest());

let agent;
let partId;
before(async () => {
    await ready;
    db.prepare("UPDATE users SET force_password_change = 0 WHERE username = 'admin'").run();
    agent = await loginAsAdmin(app);
    // 種一個料件 + 一筆出庫，供發票關聯
    partId = db.prepare(`
        INSERT INTO parts (part_number, part_name, unit, min_stock, is_active)
        VALUES ('INV-P1', '發票測試料件', '個', 0, 1)
    `).run().lastInsertRowid;
    db.prepare(`INSERT INTO inbound_records (part_id, quantity, inbound_date) VALUES (?, 100, '2026-01-01')`).run(partId);
    db.prepare(`INSERT INTO outbound_records (part_id, quantity, outbound_date, is_loan) VALUES (?, 5, '2026-01-02', 0)`).run(partId);
});

test('GET /invoices 回 200', async () => {
    const res = await agent.get('/invoices');
    assert.equal(res.status, 200);
});

test('POST /invoices/add 建立發票並寫入明細', async () => {
    const res = await postForm(agent, '/invoices/add', {
        invoice_number: 'INV-TEST-0001',
        invoice_date: '2026-01-03',
        customer_name: '測試客戶',
        customer_email: 'test@example.com',
        tax_rate: '0.05',
        // 單筆明細（server 會把非陣列值包成單元素陣列）
        item_part_id: String(partId),
        item_part_number: 'INV-P1',
        item_part_name: '發票測試料件',
        item_unit: '個',
        item_quantity: '5',
        item_unit_price: '100'
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /\/invoices\/\d+/);

    const inv = db.prepare("SELECT * FROM invoices WHERE invoice_number = 'INV-TEST-0001'").get();
    assert.ok(inv, '發票應已建立');
    assert.equal(inv.subtotal, 500);                  // 5 * 100
    assert.equal(inv.tax_amount, 25);                 // 500 * 0.05
    assert.equal(inv.total_amount, 525);
    const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(inv.id);
    assert.equal(items.length, 1);
    assert.equal(items[0].quantity, 5);
});

test('POST /invoices/add 缺發票號碼 → 驗證失敗導回', async () => {
    const res = await postForm(agent, '/invoices/add', {
        invoice_number: '',
        invoice_date: '2026-01-03',
        customer_name: '客戶'
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /\/invoices\/add/);
});

test('GET /invoices/:id 顯示發票詳情', async () => {
    const inv = db.prepare("SELECT id FROM invoices WHERE invoice_number = 'INV-TEST-0001'").get();
    const res = await agent.get(`/invoices/${inv.id}`);
    assert.equal(res.status, 200);
});

test('POST /invoices/:id/payment 更新付款狀態', async () => {
    const inv = db.prepare("SELECT id FROM invoices WHERE invoice_number = 'INV-TEST-0001'").get();
    const res = await postForm(agent, `/invoices/${inv.id}/payment`, {
        payment_status: 'paid',
        payment_date: '2026-01-10',
        payment_method: 'cash'
    });
    assert.equal(res.status, 302);
    const updated = db.prepare('SELECT payment_status FROM invoices WHERE id = ?').get(inv.id);
    assert.equal(updated.payment_status, 'paid');
});

test('GET /api/invoice-alerts 回 JSON', async () => {
    const res = await agent.get('/api/invoice-alerts');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.alerts));
});

test('GET /api/invoices/outbound-search 回出庫清單', async () => {
    const res = await agent.get('/api/invoices/outbound-search');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.records));
});

test('POST /invoices/:id/delete（管理員）刪除發票與明細', async () => {
    const inv = db.prepare("SELECT id FROM invoices WHERE invoice_number = 'INV-TEST-0001'").get();
    const res = await postForm(agent, `/invoices/${inv.id}/delete`, {});
    assert.equal(res.status, 302);
    const gone = db.prepare('SELECT id FROM invoices WHERE id = ?').get(inv.id);
    assert.equal(gone, undefined);
    const items = db.prepare('SELECT id FROM invoice_items WHERE invoice_id = ?').all(inv.id);
    assert.equal(items.length, 0);
});
