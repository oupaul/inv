// 料件管理 + 條碼/QR/料件詳情 API
const fs = require('fs');
const path = require('path');
const QRCodeGen = require('qrcode');
const logger = require('../lib/logger');
const validators = require('../lib/validators');

module.exports = function mountPartRoutes(ctx) {
    const {
        app, db, config, flash, logActivity, getSystemSetting,
        buildEmailHtml, sendNotificationEmail,
        physicalStockSql, loanedQtySql,
        hasPermission, requireAdmin,
        uploadPartImage
    } = ctx;
    const PAGE_TITLE = config.PAGE_TITLE;

    // 料件列表
    app.get('/parts', (req, res) => {
        const { search, category_id, status, sort, order, page } = req.query;
        const PAGE_SIZE = 50;
        const currentPage = Math.max(1, parseInt(page) || 1);
        const sortField = ['part_number', 'part_name', 'category_name', 'current_stock', 'created_at'].includes(sort) ? sort : 'part_number';
        const sortOrder = order === 'desc' ? 'DESC' : 'ASC';

        const whereConditions = [];
        const params = [];

        if (search && search.trim()) {
            whereConditions.push('(p.part_number LIKE ? OR p.part_name LIKE ? OR p.barcode LIKE ? OR p.specification LIKE ? OR c.name LIKE ?)');
            const t = `%${search.trim()}%`;
            params.push(t, t, t, t, t);
        }
        if (category_id && category_id !== '') {
            whereConditions.push('p.category_id = ?');
            params.push(category_id);
        }
        if (status === 'inactive') whereConditions.push('COALESCE(p.is_active, 1) = 0');
        else if (status !== 'all') whereConditions.push('COALESCE(p.is_active, 1) = 1');

        const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
        const isAdmin = req.session.user && req.session.user.role === 'admin';

        const baseQuery = `
            SELECT p.id, p.part_number, p.part_name, p.specification, p.unit, p.barcode,
                   datetime(p.created_at, '+8 hours') as created_at,
                   p.image_path, p.sell_price,
                   ${isAdmin ? 'p.cost_price,' : ''}
                   c.name as category_name,
                   COALESCE(p.is_active, 1) as is_active,
                   (${physicalStockSql('p.id')}) as current_stock
            FROM parts p
            LEFT JOIN categories c ON p.category_id = c.id
            ${whereClause}
        `;

        const totalCount = db.prepare(`SELECT COUNT(*) as total FROM (${baseQuery}) as sub`).get(...params).total;
        const totalPages = Math.ceil(totalCount / PAGE_SIZE);
        const offset = (currentPage - 1) * PAGE_SIZE;

        const orderBy = sortField === 'category_name' ? 'c.name'
                      : sortField === 'current_stock' ? 'current_stock'
                      : `p.${sortField}`;
        const parts = db.prepare(`${baseQuery} ORDER BY ${orderBy} ${sortOrder} LIMIT ? OFFSET ?`).all(...params, PAGE_SIZE, offset);

        const summaryParams = [];
        const summaryConditions = [];
        if (search && search.trim()) {
            summaryConditions.push('(p.part_number LIKE ? OR p.part_name LIKE ? OR p.barcode LIKE ? OR p.specification LIKE ? OR c.name LIKE ?)');
            const s = `%${search.trim()}%`;
            summaryParams.push(s, s, s, s, s);
        }
        if (category_id && category_id !== '') {
            summaryConditions.push('p.category_id = ?');
            summaryParams.push(category_id);
        }
        const summaryWhere = summaryConditions.length > 0 ? `WHERE ${summaryConditions.join(' AND ')}` : '';
        const summary = db.prepare(`
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN COALESCE(p.is_active, 1) = 1 THEN 1 ELSE 0 END) as active_count,
                SUM(CASE WHEN COALESCE(p.is_active, 1) = 0 THEN 1 ELSE 0 END) as inactive_count,
                SUM(CASE WHEN COALESCE(p.is_active, 1) = 1 AND (${physicalStockSql('p.id')}) <= 0 THEN 1 ELSE 0 END) as zero_stock_count
            FROM parts p
            LEFT JOIN categories c ON p.category_id = c.id
            ${summaryWhere}
        `).get(...summaryParams);

        const categories = db.prepare('SELECT * FROM categories ORDER BY name').all();
        const canDelete = hasPermission(req.session.user, 'parts', 'delete');

        res.render('parts_list', {
            parts, categories, summary,
            search: search || '',
            category_id: category_id || '',
            status: status || '',
            sort: sortField,
            order: sortOrder.toLowerCase(),
            currentPage, totalPages, totalCount,
            user: req.session.user,
            canDelete,
            title: PAGE_TITLE
        });
    });

    app.get('/parts/add', (req, res) => {
        const categories = db.prepare('SELECT * FROM categories ORDER BY name').all();
        const units = db.prepare('SELECT * FROM units ORDER BY name').all();
        res.render('add_part', { categories, units, title: PAGE_TITLE });
    });

    app.post('/parts/add', (req, res) => {
        const { part_number, part_name, specification, unit, category_id, barcode, new_category_name, new_unit_name } = req.body;
        const isAdmin = req.session.user && req.session.user.role === 'admin';
        const v = validators.check([
            ['part_number', validators.rules.partNumber(part_number)],
            ['part_name', validators.rules.partName(part_name)],
            ['barcode', validators.rules.barcode(barcode)],
            ['min_stock', validators.rules.nonNegativeInt(req.body.min_stock, { optional: true })],
            ['sell_price', validators.rules.nonNegativeNumber(req.body.sell_price)],
            ...(isAdmin ? [['cost_price', validators.rules.nonNegativeNumber(req.body.cost_price)]] : [])
        ]);
        if (!v.ok) {
            flash(req, 'error', v.errors[0].message);
            return res.redirect('/parts/add');
        }

        try {
            const txn = db.transaction(() => {
                let finalCategoryId = category_id || null;
                let finalUnit = unit || '個';

                if (category_id === '__new__' && new_category_name && new_category_name.trim()) {
                    const catName = new_category_name.trim();
                    const existing = db.prepare('SELECT id FROM categories WHERE name = ?').get(catName);
                    if (existing) finalCategoryId = existing.id;
                    else finalCategoryId = db.prepare('INSERT INTO categories (name) VALUES (?)').run(catName).lastInsertRowid;
                }
                if (unit === '__new__' && new_unit_name && new_unit_name.trim()) {
                    const unitName = new_unit_name.trim();
                    if (!db.prepare('SELECT name FROM units WHERE name = ?').get(unitName)) {
                        db.prepare('INSERT INTO units (name, symbol) VALUES (?, ?)').run(unitName, unitName);
                    }
                    finalUnit = unitName;
                }
                const sellPrice = (req.body.sell_price !== undefined && req.body.sell_price !== '') ? parseFloat(req.body.sell_price) : null;
                const costPrice = (isAdmin && req.body.cost_price !== undefined && req.body.cost_price !== '') ? parseFloat(req.body.cost_price) : null;
                const result = db.prepare(`
                    INSERT INTO parts (part_number, part_name, specification, unit, category_id, barcode, min_stock, sell_price, cost_price)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    part_number.trim(), part_name.trim(),
                    specification || null,
                    finalUnit, finalCategoryId,
                    (barcode && barcode.trim()) || null,
                    parseInt(req.body.min_stock) || 0,
                    sellPrice, costPrice
                );
                return result.lastInsertRowid;
            });
            const newId = txn();
            logActivity(req, 'create', `新增料件:${part_number} - ${part_name}`, 'part', newId);
            flash(req, 'success', '料件新增成功！');
            res.redirect('/parts');

            if (getSystemSetting('email_notify_parts', '0') === '1') {
                const partRow = db.prepare('SELECT unit FROM parts WHERE id = ?').get(newId);
                const operator = req.session && req.session.user ? (req.session.user.full_name || req.session.user.username) : '系統';
                const html = buildEmailHtml('新增料件通知', [
                    ['操作', '新增料件'],
                    ['料號', part_number],
                    ['料件名稱', part_name],
                    ['規格', specification || '-'],
                    ['單位', partRow ? partRow.unit : '-'],
                ], operator, new Date().toLocaleString('zh-TW'));
                sendNotificationEmail(`【庫存系統】新增料件 - ${part_name}`, html);
            }
        } catch (error) {
            if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                flash(req, 'error', error.message.includes('barcode') ? '條碼已存在！' : '料號已存在！');
            } else {
                logger.error('新增料件失敗:', error);
                flash(req, 'error', `新增失敗：${error.message}`);
            }
            res.redirect('/parts/add');
        }
    });

    // 上傳料件圖片
    app.post('/parts/:id/upload-image', (req, res) => {
        uploadPartImage.single('part_image')(req, res, (err) => {
            if (err) return res.json({ success: false, error: err.message });
            if (!req.file) return res.json({ success: false, error: '未收到圖片檔案' });
            const { id } = req.params;
            const part = db.prepare('SELECT id, image_path FROM parts WHERE id = ?').get(id);
            if (!part) return res.json({ success: false, error: '料件不存在' });
            if (part.image_path) {
                const oldPath = path.join(__dirname, '..', 'public', part.image_path);
                if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
            }
            const relativePath = `/uploads/parts/${req.file.filename}`;
            db.prepare('UPDATE parts SET image_path = ? WHERE id = ?').run(relativePath, id);
            logActivity(req, 'update', `上傳料件圖片 (ID: ${id})`, 'part', id);
            res.json({ success: true, image_path: relativePath });
        });
    });

    app.post('/parts/:id/delete-image', (req, res) => {
        const { id } = req.params;
        const part = db.prepare('SELECT id, image_path FROM parts WHERE id = ?').get(id);
        if (!part) return res.json({ success: false, error: '料件不存在' });
        if (part.image_path) {
            const imgPath = path.join(__dirname, '..', 'public', part.image_path);
            if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
        }
        db.prepare('UPDATE parts SET image_path = NULL WHERE id = ?').run(id);
        logActivity(req, 'update', `刪除料件圖片 (ID: ${id})`, 'part', id);
        res.json({ success: true });
    });

    // QR Code 產生
    app.get('/api/qr', async (req, res) => {
        const { text } = req.query;
        if (!text) return res.status(400).json({ error: 'text is required' });
        try {
            const dataUrl = await QRCodeGen.toDataURL(text, {
                width: 300,
                margin: 2,
                color: { dark: '#1e293b', light: '#ffffff' },
                errorCorrectionLevel: 'M'
            });
            res.json({ dataUrl });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // 料件詳情（含庫存量與近期出入庫記錄，供 Modal 使用）
    app.get('/api/parts/:id/detail', (req, res) => {
        const { id } = req.params;
        const isAdmin = req.session.user && req.session.user.role === 'admin';
        try {
            const part = db.prepare(`
                SELECT p.id, p.part_number, p.part_name, p.specification, p.unit, p.category_id,
                    p.barcode, p.created_at, p.image_path, p.min_stock, p.sell_price,
                    ${isAdmin ? 'p.cost_price,' : ''}
                    c.name as category_name,
                    COALESCE(p.is_active, 1) as is_active,
                    (${physicalStockSql('p.id')}) as current_stock,
                    (${loanedQtySql('p.id')}) as loaned_quantity
                FROM parts p
                LEFT JOIN categories c ON p.category_id = c.id
                WHERE p.id = ?
            `).get(id);
            if (!part) return res.json({ success: false, error: '找不到料件' });

            const records = db.prepare(`
                SELECT transaction_date, type, quantity, note, created_by FROM (
                    SELECT inbound_date as transaction_date,
                        CASE WHEN is_return = 1 THEN 'return' ELSE 'inbound' END as type,
                        quantity, note, created_by
                    FROM inbound_records WHERE part_id = ?
                    UNION ALL
                    SELECT outbound_date as transaction_date,
                        CASE WHEN is_loan = 1 THEN 'loan' ELSE 'outbound' END as type,
                        quantity, note, created_by
                    FROM outbound_records WHERE part_id = ?
                ) combined
                ORDER BY transaction_date DESC
                LIMIT 10
            `).all(id, id);

            res.json({ success: true, part, records });
        } catch (error) {
            logger.error('取得料件詳情失敗:', error);
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/parts/edit/:id', (req, res) => {
        const { id } = req.params;
        const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(id);
        if (!part) {
            flash(req, 'error', '料件不存在！');
            return res.redirect('/parts');
        }
        const categories = db.prepare('SELECT * FROM categories ORDER BY name').all();
        const units = db.prepare('SELECT * FROM units ORDER BY name').all();
        res.render('edit_part', { part, categories, units, title: PAGE_TITLE });
    });

    app.post('/parts/edit/:id', (req, res) => {
        const { id } = req.params;
        const { part_number, part_name, specification, unit, category_id, barcode, new_category_name, new_unit_name, min_stock } = req.body;
        const isAdmin = req.session.user && req.session.user.role === 'admin';
        const v = validators.check([
            ['id', validators.rules.positiveInt(id)],
            ['part_number', validators.rules.partNumber(part_number)],
            ['part_name', validators.rules.partName(part_name)],
            ['barcode', validators.rules.barcode(barcode)],
            ['min_stock', validators.rules.nonNegativeInt(min_stock, { optional: true })],
            ['sell_price', validators.rules.nonNegativeNumber(req.body.sell_price)],
            ...(isAdmin ? [['cost_price', validators.rules.nonNegativeNumber(req.body.cost_price)]] : [])
        ]);
        if (!v.ok) {
            flash(req, 'error', v.errors[0].message);
            return res.redirect(`/parts/edit/${id}`);
        }
        try {
            const txn = db.transaction(() => {
                let finalCategoryId = category_id || null;
                let finalUnit = unit || '個';

                if (category_id === '__new__' && new_category_name && new_category_name.trim()) {
                    const catName = new_category_name.trim();
                    const existing = db.prepare('SELECT id FROM categories WHERE name = ?').get(catName);
                    if (existing) finalCategoryId = existing.id;
                    else finalCategoryId = db.prepare('INSERT INTO categories (name) VALUES (?)').run(catName).lastInsertRowid;
                }
                if (unit === '__new__' && new_unit_name && new_unit_name.trim()) {
                    const unitName = new_unit_name.trim();
                    if (!db.prepare('SELECT name FROM units WHERE name = ?').get(unitName)) {
                        db.prepare('INSERT INTO units (name, symbol) VALUES (?, ?)').run(unitName, unitName);
                    }
                    finalUnit = unitName;
                }
                const sellPrice = (req.body.sell_price !== undefined && req.body.sell_price !== '') ? parseFloat(req.body.sell_price) : null;
                // 非管理員的表單不含成本價欄位，維持原值，不覆蓋成 NULL
                if (isAdmin) {
                    const costPrice = (req.body.cost_price !== undefined && req.body.cost_price !== '') ? parseFloat(req.body.cost_price) : null;
                    db.prepare(`
                        UPDATE parts
                        SET part_number = ?, part_name = ?, specification = ?, unit = ?, category_id = ?, barcode = ?, min_stock = ?, sell_price = ?, cost_price = ?
                        WHERE id = ?
                    `).run(
                        part_number.trim(), part_name.trim(),
                        specification || null,
                        finalUnit, finalCategoryId,
                        (barcode && barcode.trim()) || null,
                        parseInt(min_stock) || 0,
                        sellPrice, costPrice,
                        id
                    );
                } else {
                    db.prepare(`
                        UPDATE parts
                        SET part_number = ?, part_name = ?, specification = ?, unit = ?, category_id = ?, barcode = ?, min_stock = ?, sell_price = ?
                        WHERE id = ?
                    `).run(
                        part_number.trim(), part_name.trim(),
                        specification || null,
                        finalUnit, finalCategoryId,
                        (barcode && barcode.trim()) || null,
                        parseInt(min_stock) || 0,
                        sellPrice,
                        id
                    );
                }
            });
            txn();
            logActivity(req, 'update', `編輯料件：${part_number} - ${part_name}`, 'part', parseInt(id));
            flash(req, 'success', '料件更新成功！');
            res.redirect('/parts');
        } catch (error) {
            if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                flash(req, 'error', error.message.includes('barcode') ? '條碼已存在！' : '料號已存在！');
            } else {
                logger.error('編輯料件失敗:', error);
                flash(req, 'error', `更新失敗：${error.message}`);
            }
            res.redirect(`/parts/edit/${id}`);
        }
    });

    // 批量刪除料件（需要刪除權限）
    app.post('/parts/batch-delete', (req, res) => {
        if (!hasPermission(req.session.user, 'parts', 'delete')) {
            return res.status(403).json({ success: false, error: '沒有刪除權限' });
        }
        const { part_ids } = req.body;
        if (!part_ids || !Array.isArray(part_ids) || part_ids.length === 0) {
            return res.json({ success: false, error: '請選擇要刪除的料件' });
        }
        const results = { deleted: 0, deactivated: 0, failed: 0, details: [] };
        try {
            part_ids.forEach(partId => {
                try {
                    const partIdInt = parseInt(partId);
                    const part = db.prepare('SELECT part_number, part_name FROM parts WHERE id = ?').get(partIdInt);
                    if (!part) {
                        results.failed++;
                        results.details.push(`料件 ID ${partId}：找不到料件`);
                        return;
                    }
                    const stock = db.prepare(`SELECT (${physicalStockSql('?')}) as current_stock`).get(partIdInt, partIdInt);
                    const currentStock = stock ? (stock.current_stock || 0) : 0;
                    const inboundCount = db.prepare('SELECT COUNT(*) as count FROM inbound_records WHERE part_id = ?').get(partIdInt).count;
                    const outboundCount = db.prepare('SELECT COUNT(*) as count FROM outbound_records WHERE part_id = ?').get(partIdInt).count;
                    const checkCount = db.prepare('SELECT COUNT(*) as count FROM inventory_checks WHERE part_id = ?').get(partIdInt).count;

                    const hasRecords = inboundCount > 0 || outboundCount > 0 || checkCount > 0;
                    const hasStock = currentStock > 0;
                    if (hasStock || hasRecords) {
                        db.prepare('UPDATE parts SET is_active = 0 WHERE id = ?').run(partIdInt);
                        results.deactivated++;
                        const reason = [];
                        if (hasStock) reason.push(`庫存：${currentStock}`);
                        if (inboundCount > 0) reason.push(`入庫紀錄：${inboundCount}筆`);
                        if (outboundCount > 0) reason.push(`出庫紀錄：${outboundCount}筆`);
                        if (checkCount > 0) reason.push(`盤點紀錄：${checkCount}筆`);
                        results.details.push(`${part.part_number} - ${part.part_name}：已停用（${reason.join('，')}）`);
                        logActivity(req, 'update', `停用料件：${part.part_number} - ${part.part_name}（有庫存或紀錄）`, 'part', partIdInt);
                    } else {
                        db.prepare('DELETE FROM parts WHERE id = ?').run(partIdInt);
                        results.deleted++;
                        results.details.push(`${part.part_number} - ${part.part_name}：已刪除`);
                        logActivity(req, 'delete', `刪除料件：${part.part_number} - ${part.part_name}`, 'part', partIdInt);
                    }
                } catch (e) {
                    results.failed++;
                    results.details.push(`料件 ID ${partId}：處理失敗 - ${e.message}`);
                    logger.error(`批量刪除料件 ${partId} 失敗:`, e);
                }
            });
            res.json({ success: true, ...results });
        } catch (e) {
            logger.error('批量刪除料件錯誤:', e);
            res.json({ success: false, error: e.message });
        }
    });

    // 切換料件狀態（啟用/停用）- 僅管理員
    app.post('/parts/toggle-status/:id', requireAdmin, (req, res) => {
        const { id } = req.params;
        try {
            const partIdInt = parseInt(id);
            if (isNaN(partIdInt)) return res.json({ success: false, error: '無效的料件ID' });
            const part = db.prepare('SELECT id, part_number, part_name, COALESCE(is_active, 1) as is_active FROM parts WHERE id = ?').get(partIdInt);
            if (!part) return res.json({ success: false, error: '料件不存在' });
            const newStatus = part.is_active === 0 ? 1 : 0;
            db.prepare('UPDATE parts SET is_active = ? WHERE id = ?').run(newStatus, partIdInt);
            const action = newStatus === 1 ? '啟用' : '停用';
            logActivity(req, 'update', `${action}料件：${part.part_number} - ${part.part_name}`, 'part', partIdInt);
            res.json({ success: true, is_active: newStatus, message: `料件已${action}` });
        } catch (e) {
            logger.error('切換料件狀態錯誤:', e);
            res.json({ success: false, error: e.message });
        }
    });

    // 條碼查詢 API
    app.get('/api/barcode/:barcode', (req, res) => {
        const { barcode } = req.params;
        const isAdmin = req.session.user && req.session.user.role === 'admin';
        const part = db.prepare(`
            SELECT p.id, p.part_number, p.part_name, p.specification, p.unit, p.barcode,
                p.created_at, p.image_path, p.min_stock, p.sell_price,
                ${isAdmin ? 'p.cost_price,' : ''}
                c.name as category_name, c.id as category_id
            FROM parts p
            LEFT JOIN categories c ON p.category_id = c.id
            WHERE p.barcode = ?
        `).get(barcode);
        if (part) res.json({ success: true, part });
        else res.json({ success: false, message: '找不到對應的料件' });
    });
};
