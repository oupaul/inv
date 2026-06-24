// 出入庫 / 借測 / 交易紀錄 / 作廢
const logger = require('../lib/logger');
const validators = require('../lib/validators');

module.exports = function mountMovementRoutes(ctx) {
    const { app, db, config, flash, logActivity, getSystemSetting,
            buildEmailHtml, sendNotificationEmail, physicalStockSql, requireAdmin } = ctx;
    const PAGE_TITLE = config.PAGE_TITLE;

    app.get('/inbound', (req, res) => {
        const stmt = db.prepare(`
            SELECT p.*, c.name as category_name, c.id as category_id,
                   COALESCE(p.is_active, 1) as is_active
            FROM parts p
            LEFT JOIN categories c ON p.category_id = c.id
            WHERE COALESCE(p.is_active, 1) = 1
            ORDER BY p.part_number
        `);
        const parts = stmt.all();
        const categories = db.prepare('SELECT id, name FROM categories ORDER BY name').all();
    
        const today = new Date().toISOString().split('T')[0];
        res.render('inbound', { parts, categories, today, title: PAGE_TITLE });
    });
    
    // 入庫處理
    app.post('/inbound', (req, res) => {
        const { part_id, quantity, inbound_date, note, is_return, return_outbound_id } = req.body;
        const isReturn = is_return === 'on' || is_return === 'true' ? 1 : 0;
        const returnOutboundId = return_outbound_id ? parseInt(return_outbound_id) : null;
        const createdBy = req.session.user ? (req.session.user.full_name || req.session.user.username) : '系統';
    
        // 輸入驗證
        const v = validators.check([
            ['part_id', validators.rules.positiveInt(part_id)],
            ['quantity', validators.rules.positiveInt(quantity)],
            ['inbound_date', validators.rules.dateString(inbound_date)],
            ['return_outbound_id', validators.rules.positiveInt(returnOutboundId, { optional: true })]
        ]);
        if (!v.ok) {
            flash(req, 'error', v.errors[0].message);
            return res.redirect('/inbound');
        }
    
        try {
            const stmt = db.prepare(`
                INSERT INTO inbound_records (part_id, quantity, inbound_date, note, is_return, return_outbound_id, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);
            const result = stmt.run(part_id, quantity, inbound_date, note || null, isReturn, returnOutboundId, createdBy);
            
            const partStmt = db.prepare('SELECT part_number, part_name, unit FROM parts WHERE id = ?');
            const part = partStmt.get(part_id);
            const partInfo = part ? `${part.part_number} - ${part.part_name}` : `料件ID: ${part_id}`;
            const typeLabel = isReturn ? '歸還' : '入庫';
            
            logActivity(req, isReturn ? 'return' : 'inbound', `${typeLabel}：${partInfo}，數量：${quantity}`, 'inbound_record', result.lastInsertRowid);
            flash(req, 'success', isReturn ? '歸還記錄成功！' : '入庫記錄成功！');
            res.redirect('/');
    
            // 非同步發送 Email 通知
            if (getSystemSetting('email_notify_inbound', '0') === '1') {
                const operator = req.session && req.session.user ? (req.session.user.full_name || req.session.user.username) : '系統';
                const html = buildEmailHtml(`${typeLabel}通知`, [
                    ['類型',   typeLabel],
                    ['料號',   part ? part.part_number : `ID:${part_id}`],
                    ['料件名稱', part ? part.part_name : '-'],
                    ['數量',   `${quantity} ${part ? part.unit : ''}`],
                    ['日期',   inbound_date],
                    ['備註',   note || '-'],
                ], operator, new Date().toLocaleString('zh-TW'));
                sendNotificationEmail(`【庫存系統】${typeLabel}通知 - ${part ? part.part_name : part_id}`, html);
            }
        } catch (error) {
            flash(req, 'error', `入庫失敗：${error.message}`);
            res.redirect('/inbound');
        }
    });
    
    // API: 查詢料件的未歸還借測記錄
    app.get('/api/loan-records/:part_id', (req, res) => {
        const { part_id } = req.params;
        
        try {
            const stmt = db.prepare(`
                SELECT 
                    o.id,
                    o.part_id,
                    o.quantity,
                    o.outbound_date,
                    o.note,
                    o.created_at,
                    p.part_number,
                    p.part_name,
                    COALESCE(SUM(i.quantity), 0) as returned_quantity,
                    o.quantity - COALESCE(SUM(i.quantity), 0) as remaining_quantity
                FROM outbound_records o
                JOIN parts p ON o.part_id = p.id
                LEFT JOIN inbound_records i ON i.return_outbound_id = o.id
                WHERE o.part_id = ? AND o.is_loan = 1
                GROUP BY o.id
                HAVING remaining_quantity > 0
                ORDER BY o.outbound_date DESC
            `);
            
            const records = stmt.all(part_id);
            res.json({ success: true, records });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });
    
    // API: 查詢料件的可退回一般出庫記錄
    app.get('/api/outbound-records/:part_id', (req, res) => {
        const { part_id } = req.params;
        try {
            const stmt = db.prepare(`
                SELECT
                    o.id,
                    o.outbound_date,
                    o.quantity,
                    o.note,
                    o.created_by,
                    COALESCE(SUM(i.quantity), 0) as returned_qty,
                    o.quantity - COALESCE(SUM(i.quantity), 0) as remaining_qty
                FROM outbound_records o
                LEFT JOIN inbound_records i ON i.return_outbound_id = o.id AND i.is_return = 1
                WHERE o.part_id = ? AND (o.is_loan = 0 OR o.is_loan IS NULL)
                GROUP BY o.id
                HAVING remaining_qty > 0
                ORDER BY o.outbound_date DESC
                LIMIT 20
            `);
            const records = stmt.all(part_id);
            res.json({ success: true, records });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });
    
    // 入庫記錄查詢（保留舊路由以兼容）
    app.get('/inbound/records', (req, res) => {
        res.redirect('/transaction/records?type=inbound');
    });
    
    // 合併的出入庫記錄查詢（含搜尋功能）
    app.get('/transaction/records', (req, res) => {
        logActivity(req, 'view', '查看交易記錄', 'transaction_records', null);
        const { search, type, date_from, date_to } = req.query;
        
        let records = [];
        
        // 構建入庫記錄查詢
        let inboundQuery = `
            SELECT 
                ir.id as inbound_id,
                ir.inbound_date as transaction_date,
                CASE 
                    WHEN ir.is_void_reversal = 1 THEN 'void_reversal'
                    WHEN ir.is_return = 1 THEN 'return'
                    ELSE 'inbound'
                END as type,
                p.part_number,
                p.part_name,
                ir.quantity,
                p.unit,
                ir.note,
                ir.created_by,
                datetime(ir.created_at, '+8 hours') as created_at,
                ir.is_voided,
                ir.void_reason,
                ir.voided_by,
                datetime(ir.voided_at, '+8 hours') as voided_at,
                ir.is_void_reversal
            FROM inbound_records ir
            JOIN parts p ON ir.part_id = p.id
            WHERE 1=1
        `;
        let inboundParams = [];
        
        // 構建出庫記錄查詢
        let outboundQuery = `
            SELECT 
                o.outbound_date as transaction_date,
                CASE 
                    WHEN o.is_void_reversal = 1 THEN 'void_reversal'
                    WHEN o.is_loan = 1 THEN 'loan'
                    ELSE 'outbound'
                END as type,
                p.part_number,
                p.part_name,
                o.quantity,
                p.unit,
                o.note,
                o.created_by,
                datetime(o.created_at, '+8 hours') as created_at,
                o.converted_from_loan,
                o.has_invoice,
                o.invoice_number,
                o.id as outbound_id,
                (SELECT ii.invoice_id FROM invoice_items ii WHERE ii.outbound_id = o.id LIMIT 1) as linked_invoice_id,
                COALESCE((SELECT SUM(i.quantity) FROM inbound_records i WHERE i.return_outbound_id = o.id AND i.is_return = 1), 0) as returned_quantity,
                o.is_voided,
                o.void_reason,
                o.voided_by,
                datetime(o.voided_at, '+8 hours') as voided_at,
                o.is_void_reversal
            FROM outbound_records o
            JOIN parts p ON o.part_id = p.id
            WHERE 1=1
        `;
        let outboundParams = [];
        
        // 搜尋條件
        if (search && search.trim()) {
            const searchTerm = `%${search.trim()}%`;
            inboundQuery += ` AND (p.part_number LIKE ? OR p.part_name LIKE ? OR p.barcode LIKE ?)`;
            inboundParams.push(searchTerm, searchTerm, searchTerm);
            outboundQuery += ` AND (p.part_number LIKE ? OR p.part_name LIKE ? OR p.barcode LIKE ?)`;
            outboundParams.push(searchTerm, searchTerm, searchTerm);
        }
        
        // 日期範圍
        if (date_from) {
            inboundQuery += ` AND ir.inbound_date >= ?`;
            inboundParams.push(date_from);
            outboundQuery += ` AND o.outbound_date >= ?`;
            outboundParams.push(date_from);
        }
        if (date_to) {
            inboundQuery += ` AND ir.inbound_date <= ?`;
            inboundParams.push(date_to);
            outboundQuery += ` AND o.outbound_date <= ?`;
            outboundParams.push(date_to);
        }
        
        // 類型條件
        if (type === 'inbound') {
            inboundQuery += ` AND (ir.is_return = 0 OR ir.is_return IS NULL) AND (ir.is_void_reversal = 0 OR ir.is_void_reversal IS NULL) AND (ir.is_voided = 0 OR ir.is_voided IS NULL)`;
        } else if (type === 'outbound') {
            outboundQuery += ` AND (o.is_loan = 0 OR o.is_loan IS NULL) AND (o.is_void_reversal = 0 OR o.is_void_reversal IS NULL) AND (o.is_voided = 0 OR o.is_voided IS NULL)`;
        } else if (type === 'return') {
            inboundQuery += ` AND ir.is_return = 1 AND (ir.is_voided = 0 OR ir.is_voided IS NULL)`;
        } else if (type === 'loan') {
            outboundQuery += ` AND o.is_loan = 1 AND (o.is_voided = 0 OR o.is_voided IS NULL)`;
        } else if (type === 'voided') {
            inboundQuery  += ` AND ir.is_voided = 1`;
            outboundQuery += ` AND o.is_voided = 1`;
        }
    
        // 執行查詢
        if (!type || type === 'inbound' || type === 'return' || type === 'voided') {
            const inboundStmt = db.prepare(inboundQuery);
            const inboundRecords = inboundStmt.all(...inboundParams);
            records = records.concat(inboundRecords);
        }
        
        if (!type || type === 'outbound' || type === 'loan' || type === 'voided') {
            const outboundStmt = db.prepare(outboundQuery);
            const outboundRecords = outboundStmt.all(...outboundParams);
            records = records.concat(outboundRecords);
        }
        
        // 排序
        records.sort((a, b) => {
            const dateCompare = new Date(b.transaction_date) - new Date(a.transaction_date);
            if (dateCompare !== 0) return dateCompare;
            return new Date(b.created_at) - new Date(a.created_at);
        });
        
        // 限制數量
        records = records.slice(0, 500);
        
        res.render('transaction_records', { 
            records, 
            search: search || '',
            type: type || '',
            date_from: date_from || '',
            date_to: date_to || '',
            user: req.session.user,
            title: PAGE_TITLE 
        });
    });
    
    // 作廢入庫記錄（僅管理員）
    app.post('/inbound/:id/void', requireAdmin, (req, res) => {
        const { id } = req.params;
        const { void_reason } = req.body;
        const voidedBy = req.session.user.full_name || req.session.user.username;
        const now = new Date().toISOString();
        const today = now.split('T')[0];
    
        try {
            const record = db.prepare('SELECT * FROM inbound_records WHERE id = ? AND is_voided = 0 AND is_void_reversal = 0').get(id);
            if (!record) return res.json({ success: false, message: '記錄不存在、已作廢或為調整記錄' });
    
            db.transaction(() => {
                // 標記原記錄為已作廢
                db.prepare(`UPDATE inbound_records SET is_voided=1, void_reason=?, voided_by=?, voided_at=? WHERE id=?`)
                  .run(void_reason || null, voidedBy, now, id);
    
                // 建立反向出庫抵銷記錄
                db.prepare(`INSERT INTO outbound_records (part_id, quantity, outbound_date, note, is_void_reversal, void_source_id, created_by)
                            VALUES (?, ?, ?, ?, 1, ?, ?)`)
                  .run(record.part_id, record.quantity, today,
                       `【作廢調整】原入庫 #${id}${void_reason ? '：' + void_reason : ''}`,
                       record.id, voidedBy);
            })();
    
            logActivity(req, 'void', `作廢入庫記錄 #${id}${void_reason ? '：' + void_reason : ''}`, 'inbound_records', id);
            res.json({ success: true, message: '入庫記錄已作廢，庫存已自動調整' });
        } catch (e) {
            logger.error('作廢入庫失敗:', e);
            res.json({ success: false, message: '作廢失敗：' + e.message });
        }
    });
    
    // 作廢出庫記錄（僅管理員）
    app.post('/outbound/:id/void', requireAdmin, (req, res) => {
        const { id } = req.params;
        const { void_reason } = req.body;
        const voidedBy = req.session.user.full_name || req.session.user.username;
        const now = new Date().toISOString();
        const today = now.split('T')[0];
    
        try {
            const record = db.prepare('SELECT * FROM outbound_records WHERE id = ? AND is_voided = 0 AND is_void_reversal = 0').get(id);
            if (!record) return res.json({ success: false, message: '記錄不存在、已作廢或為調整記錄' });
    
            db.transaction(() => {
                // 標記原記錄為已作廢
                db.prepare(`UPDATE outbound_records SET is_voided=1, void_reason=?, voided_by=?, voided_at=? WHERE id=?`)
                  .run(void_reason || null, voidedBy, now, id);
    
                // 建立反向入庫抵銷記錄
                db.prepare(`INSERT INTO inbound_records (part_id, quantity, inbound_date, note, is_void_reversal, void_source_id, created_by)
                            VALUES (?, ?, ?, ?, 1, ?, ?)`)
                  .run(record.part_id, record.quantity, today,
                       `【作廢調整】原出庫 #${id}${void_reason ? '：' + void_reason : ''}`,
                       record.id, voidedBy);
            })();
    
            logActivity(req, 'void', `作廢出庫記錄 #${id}${void_reason ? '：' + void_reason : ''}`, 'outbound_records', id);
            res.json({ success: true, message: '出庫記錄已作廢，庫存已自動調整' });
        } catch (e) {
            logger.error('作廢出庫失敗:', e);
            res.json({ success: false, message: '作廢失敗：' + e.message });
        }
    });

    // 編輯出入庫記錄的備註（建立者或管理員）
    // 已作廢 / 作廢反向 記錄不可編輯
    function userCanEditNote(reqUser, record) {
        if (!reqUser || !record) return false;
        if (reqUser.role === 'admin') return true;
        const currentName = reqUser.full_name || reqUser.username;
        return currentName && currentName === record.created_by;
    }

    function buildNoteRoute(tableName, label) {
        return (req, res) => {
            const { id } = req.params;
            const newNote = (req.body && typeof req.body.note === 'string') ? req.body.note : '';
            if (newNote.length > 1000) {
                return res.json({ success: false, error: '備註長度不可超過 1000 字元' });
            }
            try {
                const record = db.prepare(
                    `SELECT id, note, created_by, is_voided, is_void_reversal FROM ${tableName} WHERE id = ?`
                ).get(id);
                if (!record) return res.json({ success: false, error: '記錄不存在' });
                if (record.is_voided == 1) return res.json({ success: false, error: '已作廢的記錄不可編輯' });
                if (record.is_void_reversal == 1) return res.json({ success: false, error: '作廢調整記錄不可編輯' });
                if (!userCanEditNote(req.session.user, record)) {
                    return res.status(403).json({ success: false, error: '沒有權限編輯此筆備註（須為建立者或管理員）' });
                }

                const trimmedNew = newNote.trim();
                const oldNote = record.note || '';
                if (trimmedNew === oldNote.trim()) {
                    return res.json({ success: true, note: oldNote, unchanged: true });
                }

                db.prepare(`UPDATE ${tableName} SET note = ? WHERE id = ?`).run(trimmedNew || null, id);
                logActivity(req, 'update',
                    `修改${label}備註 #${id}：${oldNote ? `「${oldNote}」` : '（空）'} → ${trimmedNew ? `「${trimmedNew}」` : '（空）'}`,
                    tableName, parseInt(id));
                res.json({ success: true, note: trimmedNew });
            } catch (e) {
                logger.error(`修改${label}備註失敗:`, e);
                res.json({ success: false, error: e.message });
            }
        };
    }

    app.post('/inbound/:id/note',  buildNoteRoute('inbound_records',  '入庫'));
    app.post('/outbound/:id/note', buildNoteRoute('outbound_records', '出庫'));

    // 出庫頁面
    app.get('/outbound', (req, res) => {
        // 可出庫數量 = 物理庫存 = SUM(inbound) - SUM(outbound)
        // 一般出庫、借測、退回、借測歸還、作廢反向皆已透過 inbound/outbound 雙邊登錄自動正確抵銷
        const stmt = db.prepare(`
            SELECT
                p.*,
                c.name as category_name,
                c.id as category_id,
                COALESCE(p.is_active, 1) as is_active,
                (${physicalStockSql('p.id')}) as current_stock
            FROM parts p
            LEFT JOIN categories c ON p.category_id = c.id
            WHERE COALESCE(p.is_active, 1) = 1
              AND (${physicalStockSql('p.id')}) > 0
            ORDER BY p.part_number
        `);
        const parts = stmt.all();
        
        // 獲取所有類別（用於篩選）
        const categoriesStmt = db.prepare('SELECT * FROM categories ORDER BY name');
        const categories = categoriesStmt.all();
        
        const today = new Date().toISOString().split('T')[0];
        res.render('outbound', {
            parts, categories, today,
            query: req.query,
            user: req.session.user,
            csrfToken: req.session.csrfToken,
            title: PAGE_TITLE
        });
    });
    
    // 出庫處理
    app.post('/outbound', (req, res) => {
        const { part_id, quantity, outbound_date, note, is_loan, loan_due_date } = req.body;
        const isLoan = is_loan === 'on' || is_loan === 'true' ? 1 : 0;
        const qty = parseInt(quantity) || 0;
    
        // 輸入驗證
        const v = validators.check([
            ['part_id', validators.rules.positiveInt(part_id)],
            ['quantity', validators.rules.positiveInt(qty)],
            ['outbound_date', validators.rules.dateString(outbound_date)],
            ['loan_due_date', validators.rules.dateString(loan_due_date, { optional: !isLoan })]
        ]);
        if (!v.ok) {
            flash(req, 'error', v.errors[0].message);
            return res.redirect('/outbound');
        }
    
        try {
            // 檢查庫存是否足夠（物理庫存）
            const stockStmt = db.prepare(`SELECT (${physicalStockSql('?')}) as available_stock`);
            const stock = stockStmt.get(part_id, part_id);
            const availableStock = stock ? (stock.available_stock || 0) : 0;
            
            if (availableStock < qty) {
                flash(req, 'error', `庫存不足！可用庫存：${availableStock}，需要：${qty}`);
                return res.redirect('/outbound');
            }
            
            // 如果是借測，檢查是否提供了到期日期
            if (isLoan && (!loan_due_date || loan_due_date.trim() === '')) {
                flash(req, 'error', '借測必須填寫到期日期！');
                return res.redirect('/outbound');
            }
            
            const createdBy = req.session.user ? (req.session.user.full_name || req.session.user.username) : '系統';
            
            // 處理發票信息（僅非借測時）
            let hasInvoice = 0;
            let invoiceNumber = null;
            
            if (!isLoan) {
                // 非借測時才處理發票信息
                hasInvoice = (req.body.has_invoice === 'on' || req.body.has_invoice === 'true' || req.body.has_invoice === true) ? 1 : 0;
                invoiceNumber = hasInvoice === 1 && req.body.invoice_number ? String(req.body.invoice_number).trim() : null;
                if (invoiceNumber === '') {
                    invoiceNumber = null;
                }
            }
            
            const stmt = db.prepare(`
                INSERT INTO outbound_records (part_id, quantity, outbound_date, note, is_loan, loan_due_date, notification_sent, created_by, has_invoice, invoice_number)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const result = stmt.run(
                parseInt(part_id), 
                parseInt(qty), 
                String(outbound_date), 
                note ? String(note) : null, 
                isLoan ? 1 : 0,
                (isLoan && loan_due_date) ? String(loan_due_date) : null,
                0,  // 預設未發送通知
                String(createdBy),
                hasInvoice,
                invoiceNumber
            );
            
            const partStmt = db.prepare('SELECT part_number, part_name, unit FROM parts WHERE id = ?');
            const part = partStmt.get(part_id);
            const partInfo = part ? `${part.part_number} - ${part.part_name}` : `料件ID: ${part_id}`;
            const outTypeLabel = isLoan ? '借測' : '出庫';
            
            logActivity(req, isLoan ? 'loan' : 'outbound', `${outTypeLabel}：${partInfo}，數量：${qty}`, 'outbound_record', result.lastInsertRowid);
            flash(req, 'success', isLoan ? '借測記錄成功！' : '出庫記錄成功！');
    
            // 有記錄發票號碼時，跳回出庫頁並帶提示參數，引導建立完整發票管理記錄
            if (!isLoan && hasInvoice && invoiceNumber) {
                return res.redirect(`/outbound?inv_prompt=1&ob_id=${result.lastInsertRowid}&inv_no=${encodeURIComponent(invoiceNumber)}`);
            }
            res.redirect('/');
    
            // 非同步發送 Email 通知
            if (getSystemSetting('email_notify_outbound', '0') === '1') {
                const operator = req.session && req.session.user ? (req.session.user.full_name || req.session.user.username) : '系統';
                const emailRows = [
                    ['類型',   outTypeLabel],
                    ['料號',   part ? part.part_number : `ID:${part_id}`],
                    ['料件名稱', part ? part.part_name : '-'],
                    ['數量',   `${qty} ${part ? part.unit : ''}`],
                    ['日期',   outbound_date],
                    ['備註',   note || '-'],
                ];
                if (isLoan) emailRows.push(['借測到期', loan_due_date || '-']);
                if (!isLoan && hasInvoice) emailRows.push(['發票號碼', invoiceNumber || '-']);
                const html = buildEmailHtml(`${outTypeLabel}通知`, emailRows, operator, new Date().toLocaleString('zh-TW'));
                sendNotificationEmail(`【庫存系統】${outTypeLabel}通知 - ${part ? part.part_name : part_id}`, html);
            }
        } catch (error) {
            flash(req, 'error', `出庫失敗：${error.message}`);
            res.redirect('/outbound');
        }
    });
    
    // 出庫記錄查詢（保留舊路由以兼容，重定向到合併頁面）
    app.get('/outbound/records', (req, res) => {
        res.redirect('/transaction/records?type=outbound');
    });
    
    // API: 獲取到期通知
    app.get('/api/loan-notifications', (req, res) => {
        try {
            // 獲取已過期、今日到期、以及3天內即將到期的借測記錄
            const stmt = db.prepare(`
                SELECT 
                    o.id,
                    o.outbound_date as loan_date,
                    o.loan_due_date,
                    o.notification_sent,
                    p.part_number,
                    p.part_name,
                    p.unit,
                    o.quantity - COALESCE(SUM(i.quantity), 0) as remaining_quantity,
                    CASE 
                        WHEN date(o.loan_due_date) < date('now', '+8 hours') THEN 'overdue'
                        WHEN date(o.loan_due_date) = date('now', '+8 hours') THEN 'due_today'
                        WHEN date(o.loan_due_date) <= date('now', '+8 hours', '+3 days') THEN 'due_soon'
                        ELSE 'normal'
                    END as due_status,
                    CASE 
                        WHEN o.loan_due_date IS NULL THEN NULL
                        ELSE julianday(o.loan_due_date) - julianday('now', '+8 hours')
                    END as days_until_due
                FROM outbound_records o
                JOIN parts p ON o.part_id = p.id
                LEFT JOIN inbound_records i ON i.return_outbound_id = o.id
                WHERE o.is_loan = 1 
                    AND o.loan_due_date IS NOT NULL
                    AND (date(o.loan_due_date) <= date('now', '+8 hours', '+3 days'))
                GROUP BY o.id
                HAVING remaining_quantity > 0
                ORDER BY 
                    CASE 
                        WHEN date(o.loan_due_date) < date('now', '+8 hours') THEN 0
                        WHEN date(o.loan_due_date) = date('now', '+8 hours') THEN 1
                        ELSE 2
                    END,
                    o.loan_due_date ASC
            `);
            
            const notifications = stmt.all();
            
            // 統計各類型通知數量
            const stats = {
                overdue: notifications.filter(n => n.due_status === 'overdue').length,
                due_today: notifications.filter(n => n.due_status === 'due_today').length,
                due_soon: notifications.filter(n => n.due_status === 'due_soon').length,
                total: notifications.length
            };
            
            res.json({ success: true, notifications, stats });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });
    
    // 標記通知已讀（更新 notification_sent）
    app.post('/api/loan-notifications/:id/mark-read', (req, res) => {
        const { id } = req.params;
        
        try {
            const stmt = db.prepare('UPDATE outbound_records SET notification_sent = 1 WHERE id = ?');
            stmt.run(id);
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });
    
    // 借出中料件列表
    app.get('/loans', (req, res) => {
        const stmt = db.prepare(`
            SELECT 
                o.id,
                o.part_id,
                o.quantity as loaned_quantity,
                o.outbound_date as loan_date,
                o.loan_due_date,
                o.notification_sent,
                o.note as loan_note,
                o.created_at as loan_created_at,
                p.part_number,
                p.part_name,
                p.specification,
                p.unit,
                p.barcode,
                c.name as category_name,
                COALESCE(SUM(i.quantity), 0) as returned_quantity,
                o.quantity - COALESCE(SUM(i.quantity), 0) as remaining_quantity,
                CASE 
                    WHEN o.quantity - COALESCE(SUM(i.quantity), 0) = o.quantity THEN '未歸還'
                    WHEN o.quantity - COALESCE(SUM(i.quantity), 0) > 0 THEN '部分歸還'
                    ELSE '已歸還'
                END as status,
                CASE 
                    WHEN o.loan_due_date IS NULL THEN '無到期日期'
                    WHEN date(o.loan_due_date) < date('now', '+8 hours') THEN '已過期'
                    WHEN date(o.loan_due_date) = date('now', '+8 hours') THEN '今日到期'
                    WHEN date(o.loan_due_date) <= date('now', '+8 hours', '+3 days') THEN '即將到期'
                    ELSE '正常'
                END as due_status,
                CASE 
                    WHEN o.loan_due_date IS NULL THEN NULL
                    ELSE julianday(o.loan_due_date) - julianday('now', '+8 hours')
                END as days_until_due
            FROM outbound_records o
            JOIN parts p ON o.part_id = p.id
            LEFT JOIN categories c ON p.category_id = c.id
            LEFT JOIN inbound_records i ON i.return_outbound_id = o.id
            WHERE o.is_loan = 1
            GROUP BY o.id
            HAVING remaining_quantity > 0
            ORDER BY 
                CASE 
                    WHEN o.loan_due_date IS NULL THEN 999
                    WHEN date(o.loan_due_date) < date('now', '+8 hours') THEN 0
                    WHEN date(o.loan_due_date) = date('now', '+8 hours') THEN 1
                    WHEN date(o.loan_due_date) <= date('now', '+8 hours', '+3 days') THEN 2
                    ELSE 3
                END,
                o.loan_due_date ASC,
                o.outbound_date DESC
        `);
        
        const records = stmt.all();
        res.render('loan_records', { records, user: req.session.user, title: PAGE_TITLE });
    });
    
    // API: 將借測記錄轉為正常出貨
    app.post('/api/loans/convert-to-outbound/:id', (req, res) => {
        const { id } = req.params;
        
        try {
            // 檢查記錄是否存在且是借測記錄
            const checkStmt = db.prepare(`
                SELECT 
                    o.id,
                    o.part_id,
                    o.quantity as loaned_quantity,
                    o.is_loan,
                    p.part_number,
                    p.part_name,
                    COALESCE(SUM(i.quantity), 0) as returned_quantity,
                    o.quantity - COALESCE(SUM(i.quantity), 0) as remaining_quantity
                FROM outbound_records o
                JOIN parts p ON o.part_id = p.id
                LEFT JOIN inbound_records i ON i.return_outbound_id = o.id
                WHERE o.id = ? AND o.is_loan = 1
                GROUP BY o.id
            `);
            
            const record = checkStmt.get(id);
            
            if (!record) {
                return res.json({ 
                    success: false, 
                    error: '找不到該借測記錄或該記錄不是借測記錄' 
                });
            }
            
            // 檢查是否有未歸還的數量
            if (record.remaining_quantity <= 0) {
                return res.json({ 
                    success: false, 
                    error: '該借測記錄已全部歸還，無法轉為出貨' 
                });
            }
            
            // 將借測記錄轉為正常出貨，標記為借測轉換而來
            const updateStmt = db.prepare(`
                UPDATE outbound_records 
                SET is_loan = 0, 
                    loan_due_date = NULL,
                    notification_sent = 0,
                    converted_from_loan = 1
                WHERE id = ?
            `);
            
            updateStmt.run(id);
            
            // 記錄活動
            const partInfo = `${record.part_number} - ${record.part_name}`;
            logActivity(req, 'outbound', `借測轉出貨：${partInfo}，數量：${record.loaned_quantity}（未歸還：${record.remaining_quantity}）`, 'outbound_record', id);
            
            res.json({ 
                success: true, 
                message: '轉換成功',
                remaining_quantity: record.remaining_quantity
            });
        } catch (error) {
            logger.error('轉換借測記錄錯誤:', error);
            res.json({ 
                success: false, 
                error: error.message || '轉換失敗' 
            });
        }
    });
    
    // API: 更新出庫記錄的發票信息
    app.post('/api/outbound/:id/invoice', (req, res) => {
        const { id } = req.params;
        const { has_invoice, invoice_number } = req.body;
        
        try {
            const hasInvoice = has_invoice === true || has_invoice === 'true' || has_invoice === 1 ? 1 : 0;
            const invoiceNumber = hasInvoice && invoice_number ? invoice_number.trim() : null;
            
            // 檢查記錄是否存在
            const checkStmt = db.prepare('SELECT id, part_id FROM outbound_records WHERE id = ?');
            const record = checkStmt.get(id);
            
            if (!record) {
                return res.json({ 
                    success: false, 
                    error: '找不到該出庫記錄' 
                });
            }
            
            // 獲取料件信息
            const partStmt = db.prepare('SELECT part_number, part_name FROM parts WHERE id = ?');
            const part = partStmt.get(record.part_id);
            const partInfo = part ? `${part.part_number} - ${part.part_name}` : `料件ID: ${record.part_id}`;
            
            // 更新發票信息
            const updateStmt = db.prepare(`
                UPDATE outbound_records 
                SET has_invoice = ?, 
                    invoice_number = ?
                WHERE id = ?
            `);
            
            updateStmt.run(hasInvoice, invoiceNumber, id);
            
            // 記錄活動
            const action = hasInvoice ? '添加發票信息' : '移除發票信息';
            const detail = hasInvoice && invoiceNumber ? `${action}：${partInfo}，發票號碼：${invoiceNumber}` : `${action}：${partInfo}`;
            logActivity(req, 'update', detail, 'outbound_record', id);
            
            res.json({ 
                success: true, 
                message: hasInvoice ? '發票信息已更新' : '發票信息已移除',
                has_invoice: hasInvoice,
                invoice_number: invoiceNumber
            });
        } catch (error) {
            logger.error('更新發票信息錯誤:', error);
            res.json({ 
                success: false, 
                error: error.message || '更新失敗' 
            });
        }
    });
};
