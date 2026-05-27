// 發票管理
const logger = require('../lib/logger');
const validators = require('../lib/validators');

module.exports = function mountInvoiceRoutes(ctx) {
    const { app, db, flash, logActivity, requireAdmin } = ctx;

    // 輔助：產生發票號碼（INV-YYYYMMDD-XXXX）
    function generateInvoiceNumber() {
        const now = new Date();
        const dateStr = now.getFullYear().toString() +
            String(now.getMonth() + 1).padStart(2, '0') +
            String(now.getDate()).padStart(2, '0');
        const last = db.prepare(`SELECT invoice_number FROM invoices WHERE invoice_number LIKE ? ORDER BY id DESC LIMIT 1`).get(`INV-${dateStr}-%`);
        let seq = 1;
        if (last) {
            const parts = last.invoice_number.split('-');
            seq = parseInt(parts[parts.length - 1]) + 1;
        }
        return `INV-${dateStr}-${String(seq).padStart(4, '0')}`;
    }

    // 從 req.body 解析發票明細列（add / edit 共用）
    function parseLineItems(body) {
        const toArr = (v) => Array.isArray(v) ? v : (v ? [v] : []);
        const quantities  = toArr(body.item_quantity);
        const unitPrices  = toArr(body.item_unit_price);
        const partIds     = toArr(body.item_part_id);
        const partNumbers = toArr(body.item_part_number);
        const partNames   = toArr(body.item_part_name);
        const specs       = toArr(body.item_specification);
        const units       = toArr(body.item_unit);
        const outboundIds = toArr(body.item_outbound_id);
        let subtotal = 0;
        const lineItems = quantities.map((q, i) => {
            const qty = parseInt(q) || 0;
            const price = parseFloat(unitPrices[i]) || 0;
            const sub = qty * price;
            subtotal += sub;
            return { qty, price, sub,
                part_id: partIds[i] || null,
                part_number: partNumbers[i] || '',
                part_name: partNames[i] || '',
                specification: specs[i] || '',
                unit: units[i] || '',
                outbound_id: parseInt(outboundIds[i]) || null
            };
        });
        return { lineItems, subtotal };
    }

    // 發票清單
    app.get('/invoices', (req, res) => {
        logActivity(req, 'view', '查看發票清單', 'invoice', null);
        const { status, search, date_from, date_to } = req.query;
        const where = [];
        const params = [];
        if (status) { where.push('i.payment_status = ?'); params.push(status); }
        if (search) {
            where.push('(i.invoice_number LIKE ? OR i.customer_name LIKE ?)');
            params.push(`%${search}%`, `%${search}%`);
        }
        if (date_from) { where.push('i.invoice_date >= ?'); params.push(date_from); }
        if (date_to)   { where.push('i.invoice_date <= ?'); params.push(date_to); }
        const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

        const invoices = db.prepare(`
            SELECT i.*,
                COUNT(ii.id) as item_count,
                CASE
                    WHEN i.payment_status = 'paid' THEN '已付清'
                    WHEN i.payment_status = 'partial' THEN '部分付款'
                    WHEN i.payment_due_date IS NOT NULL AND date(i.payment_due_date) < date('now', '+8 hours') THEN '已逾期'
                    ELSE '未付款'
                END as status_label,
                CASE
                    WHEN i.payment_status = 'paid' THEN 3
                    WHEN i.payment_due_date IS NOT NULL AND date(i.payment_due_date) < date('now', '+8 hours') THEN 0
                    WHEN i.payment_status = 'partial' THEN 1
                    ELSE 2
                END as sort_order
            FROM invoices i
            LEFT JOIN invoice_items ii ON ii.invoice_id = i.id
            ${whereClause}
            GROUP BY i.id
            ORDER BY sort_order ASC, i.invoice_date DESC
        `).all(...params);

        const stats = {
            total: db.prepare('SELECT COUNT(*) as c FROM invoices').get().c,
            unpaid: db.prepare("SELECT COUNT(*) as c FROM invoices WHERE payment_status = 'unpaid'").get().c,
            partial: db.prepare("SELECT COUNT(*) as c FROM invoices WHERE payment_status = 'partial'").get().c,
            paid: db.prepare("SELECT COUNT(*) as c FROM invoices WHERE payment_status = 'paid'").get().c,
            overdue: db.prepare("SELECT COUNT(*) as c FROM invoices WHERE payment_status != 'paid' AND payment_due_date IS NOT NULL AND date(payment_due_date) < date('now', '+8 hours')").get().c,
            totalAmount: db.prepare("SELECT COALESCE(SUM(total_amount),0) as s FROM invoices WHERE payment_status != 'paid'").get().s,
        };

        res.render('invoices_list', {
            invoices, stats,
            filters: { status: status || '', search: search || '', date_from: date_from || '', date_to: date_to || '' },
            user: req.session.user,
            csrfToken: req.session.csrfToken,
            title: '發票管理'
        });
    });

    // 新增發票（表單）
    app.get('/invoices/add', (req, res) => {
        const outbound_ids = req.query.outbound_ids ? req.query.outbound_ids.split(',').map(Number).filter(Boolean) : [];
        const presetInvoiceNumber = req.query.invoice_number || null;
        let preloadedItems = [];
        if (outbound_ids.length > 0) {
            const placeholders = outbound_ids.map(() => '?').join(',');
            preloadedItems = db.prepare(`
                SELECT o.id as outbound_id, o.outbound_date, o.note, o.quantity,
                    p.id as part_id, p.part_number, p.part_name, p.specification, p.unit
                FROM outbound_records o
                JOIN parts p ON o.part_id = p.id
                WHERE o.id IN (${placeholders}) AND o.is_loan = 0
            `).all(...outbound_ids);
        }
        res.render('invoice_add', {
            invoice: null,
            items: preloadedItems,
            invoiceNumber: presetInvoiceNumber || generateInvoiceNumber(),
            presetInvoiceNumber,
            user: req.session.user,
            csrfToken: req.session.csrfToken,
            title: '新增發票'
        });
    });

    // 新增發票（送出）
    app.post('/invoices/add', (req, res) => {
        const {
            invoice_number, invoice_date, customer_name, customer_contact,
            customer_phone, customer_email, tax_rate, payment_due_date, payment_method, note
        } = req.body;

        const v = validators.check([
            ['invoice_number', validators.rules.displayName(invoice_number, { label: '發票號碼', max: 50 })],
            ['invoice_date', validators.rules.dateString(invoice_date)],
            ['customer_name', validators.rules.displayName(customer_name, { label: '客戶名稱', max: 200 })],
            ['customer_email', validators.rules.email(customer_email, { optional: true })],
            ['payment_due_date', validators.rules.dateString(payment_due_date, { optional: true })]
        ]);
        if (!v.ok) {
            flash(req, 'error', v.errors[0].message);
            return res.redirect('/invoices/add');
        }

        const taxRateVal = parseFloat(tax_rate) || 0;
        const { lineItems, subtotal } = parseLineItems(req.body);
        const taxAmount = Math.round(subtotal * taxRateVal * 100) / 100;
        const totalAmount = Math.round((subtotal + taxAmount) * 100) / 100;

        try {
            const invoiceId = db.transaction(() => {
                const result = db.prepare(`
                    INSERT INTO invoices (invoice_number, invoice_date, customer_name, customer_contact,
                        customer_phone, customer_email, subtotal, tax_rate, tax_amount, total_amount,
                        payment_status, payment_due_date, payment_method, note, created_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', ?, ?, ?, ?)
                `).run(
                    invoice_number, invoice_date, customer_name,
                    customer_contact || null, customer_phone || null, customer_email || null,
                    subtotal, taxRateVal, taxAmount, totalAmount,
                    payment_due_date || null, payment_method || null, note || null,
                    req.session.user.username
                );
                const newId = result.lastInsertRowid;
                const itemStmt = db.prepare(`
                    INSERT INTO invoice_items (invoice_id, outbound_id, part_id, part_number, part_name, specification, unit, quantity, unit_price, subtotal)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);
                lineItems.forEach(item => {
                    if (item.qty > 0) {
                        itemStmt.run(newId, item.outbound_id, item.part_id, item.part_number, item.part_name, item.specification, item.unit, item.qty, item.price, item.sub);
                    }
                });
                return newId;
            })();

            logActivity(req, 'create', `新增發票 ${invoice_number}，客戶：${customer_name}，金額：${totalAmount}`, 'invoice', invoiceId);
            flash(req, 'success', `發票 ${invoice_number} 新增成功！`);
            res.redirect(`/invoices/${invoiceId}`);
        } catch (error) {
            if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                flash(req, 'error', `發票號碼 ${invoice_number} 已存在`);
            } else {
                logger.error('新增發票失敗:', error);
                flash(req, 'error', `新增失敗：${error.message}`);
            }
            res.redirect('/invoices/add');
        }
    });

    // 編輯發票（顯示）
    app.get('/invoices/:id/edit', (req, res) => {
        const { id } = req.params;
        const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
        if (!invoice) { flash(req, 'error', '找不到該發票'); return res.redirect('/invoices'); }
        const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(id);
        res.render('invoice_add', {
            invoice, items,
            invoiceNumber: invoice.invoice_number,
            presetInvoiceNumber: null,
            user: req.session.user,
            csrfToken: req.session.csrfToken,
            title: `編輯發票 ${invoice.invoice_number}`
        });
    });

    // 編輯發票（儲存）
    app.post('/invoices/:id/edit', (req, res) => {
        const { id } = req.params;
        const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
        if (!invoice) { flash(req, 'error', '找不到該發票'); return res.redirect('/invoices'); }

        const {
            invoice_number, invoice_date, customer_name, customer_contact,
            customer_phone, customer_email, tax_rate, payment_due_date, payment_method, note
        } = req.body;

        const ev = validators.check([
            ['invoice_number', validators.rules.displayName(invoice_number, { label: '發票號碼', max: 50 })],
            ['invoice_date', validators.rules.dateString(invoice_date)],
            ['customer_name', validators.rules.displayName(customer_name, { label: '客戶名稱', max: 200 })],
            ['customer_email', validators.rules.email(customer_email, { optional: true })],
            ['payment_due_date', validators.rules.dateString(payment_due_date, { optional: true })]
        ]);
        if (!ev.ok) {
            flash(req, 'error', ev.errors[0].message);
            return res.redirect(`/invoices/${id}/edit`);
        }

        const taxRateVal = parseFloat(tax_rate) || 0;
        const { lineItems, subtotal } = parseLineItems(req.body);
        const taxAmount = Math.round(subtotal * taxRateVal * 100) / 100;
        const totalAmount = Math.round((subtotal + taxAmount) * 100) / 100;

        try {
            db.transaction(() => {
                db.prepare(`
                    UPDATE invoices SET
                        invoice_number=?, invoice_date=?, customer_name=?, customer_contact=?,
                        customer_phone=?, customer_email=?, subtotal=?, tax_rate=?, tax_amount=?,
                        total_amount=?, payment_due_date=?, payment_method=?, note=?
                    WHERE id=?
                `).run(
                    invoice_number, invoice_date, customer_name,
                    customer_contact || null, customer_phone || null, customer_email || null,
                    subtotal, taxRateVal, taxAmount, totalAmount,
                    payment_due_date || null, payment_method || null, note || null,
                    id
                );
                db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(id);
                const itemStmt = db.prepare(`
                    INSERT INTO invoice_items (invoice_id, outbound_id, part_id, part_number, part_name, specification, unit, quantity, unit_price, subtotal)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);
                lineItems.forEach(item => {
                    if (item.qty > 0) {
                        itemStmt.run(id, item.outbound_id, item.part_id, item.part_number, item.part_name, item.specification, item.unit, item.qty, item.price, item.sub);
                    }
                });
            })();

            logActivity(req, 'update', `編輯發票 ${invoice_number}，金額：${totalAmount}`, 'invoice', id);
            flash(req, 'success', `發票 ${invoice_number} 已更新！`);
            res.redirect(`/invoices/${id}`);
        } catch (error) {
            flash(req, 'error', `更新失敗：${error.message}`);
            res.redirect(`/invoices/${id}/edit`);
        }
    });

    // 發票詳情
    app.get('/invoices/:id', (req, res) => {
        const { id } = req.params;
        const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
        if (!invoice) { flash(req, 'error', '找不到該發票'); return res.redirect('/invoices'); }
        const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(id);
        logActivity(req, 'view', `查看發票 ${invoice.invoice_number}`, 'invoice', id);
        res.render('invoice_detail', {
            invoice, items,
            user: req.session.user,
            csrfToken: req.session.csrfToken,
            title: `發票 ${invoice.invoice_number}`
        });
    });

    // 更新付款狀態
    app.post('/invoices/:id/payment', (req, res) => {
        const { id } = req.params;
        const { payment_status, payment_date, payment_method, payment_note } = req.body;
        const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
        if (!invoice) { flash(req, 'error', '找不到該發票'); return res.redirect('/invoices'); }
        db.prepare(`
            UPDATE invoices SET payment_status = ?, payment_date = ?, payment_method = ?,
                payment_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(payment_status, payment_date || null, payment_method || invoice.payment_method || null, payment_note || null, id);
        logActivity(req, 'update', `更新發票 ${invoice.invoice_number} 付款狀態為 ${payment_status}`, 'invoice', id);
        flash(req, 'success', '付款狀態已更新！');
        res.redirect(`/invoices/${id}`);
    });

    // 刪除發票
    app.post('/invoices/:id/delete', requireAdmin, (req, res) => {
        const { id } = req.params;
        const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
        if (!invoice) { flash(req, 'error', '找不到該發票'); return res.redirect('/invoices'); }
        db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(id);
        db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
        logActivity(req, 'delete', `刪除發票 ${invoice.invoice_number}`, 'invoice', id);
        flash(req, 'success', `發票 ${invoice.invoice_number} 已刪除`);
        res.redirect('/invoices');
    });

    // API：搜尋出庫記錄（供新增發票時選擇）
    app.get('/api/invoices/outbound-search', (req, res) => {
        const { q, date_from, date_to } = req.query;
        const where = ['o.is_loan = 0'];
        const params = [];
        if (q) { where.push('(p.part_name LIKE ? OR p.part_number LIKE ? OR o.note LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
        if (date_from) { where.push('o.outbound_date >= ?'); params.push(date_from); }
        if (date_to)   { where.push('o.outbound_date <= ?'); params.push(date_to); }
        const rows = db.prepare(`
            SELECT o.id, o.outbound_date, o.quantity, o.note, o.created_by,
                o.has_invoice, o.invoice_number as ob_invoice_number,
                p.part_number, p.part_name, p.specification, p.unit, p.id as part_id,
                (SELECT COUNT(*) FROM invoice_items ii WHERE ii.outbound_id = o.id) as linked_invoice_count
            FROM outbound_records o
            JOIN parts p ON o.part_id = p.id
            WHERE ${where.join(' AND ')}
            ORDER BY o.outbound_date DESC
            LIMIT 50
        `).all(...params);
        res.json({ success: true, records: rows });
    });

    // API：應收帳款到期警示（儀錶板用）
    app.get('/api/invoice-alerts', (req, res) => {
        const alerts = db.prepare(`
            SELECT id, invoice_number, customer_name, total_amount, payment_due_date,
                CASE
                    WHEN date(payment_due_date) < date('now', '+8 hours') THEN 'overdue'
                    WHEN date(payment_due_date) = date('now', '+8 hours') THEN 'due_today'
                    ELSE 'due_soon'
                END as due_status,
                CAST(julianday(payment_due_date) - julianday('now', '+8 hours') AS INTEGER) as days_until_due
            FROM invoices
            WHERE payment_status != 'paid'
                AND payment_due_date IS NOT NULL
                AND date(payment_due_date) <= date('now', '+8 hours', '+7 days')
            ORDER BY payment_due_date ASC
            LIMIT 10
        `).all();
        res.json({ success: true, alerts });
    });
};
