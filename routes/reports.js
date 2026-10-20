// 匯出 / 匯入（Excel）
const fs = require('fs');
const ExcelJS = require('exceljs');
const logger = require('../lib/logger');

module.exports = function mountReportRoutes(ctx) {
    const { app, db, config, flash, logActivity, physicalStockSql, upload } = ctx;
    const PAGE_TITLE = config.PAGE_TITLE;

    // 匯出盤點報表
    app.get('/export/inventory-check', async (req, res) => {
        try {
        logActivity(req, 'export', '匯出盤點報表', 'export', null);
        const { search, date_from, date_to, session_id } = req.query;

        let whereConditions = [];
        let params = [];

        // 搜尋條件
        if (search && search.trim()) {
            whereConditions.push(`(p.part_number LIKE ? OR p.part_name LIKE ? OR p.barcode LIKE ?)`);
            const searchTerm = `%${search.trim()}%`;
            params.push(searchTerm, searchTerm, searchTerm);
        }

        // 盤點事件篩選（修正：先前此參數有傳但後端未讀取，匯出時完全不會生效）
        if (session_id && session_id !== '') {
            whereConditions.push(`ic.session_id = ?`);
            params.push(session_id);
        }

        // 日期範圍
        if (date_from) {
            whereConditions.push(`ic.check_date >= ?`);
            params.push(date_from);
        }
        if (date_to) {
            whereConditions.push(`ic.check_date <= ?`);
            params.push(date_to);
        }

        const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

        const stmt = db.prepare(`
            SELECT
                ic.check_date as '盤點日期',
                p.part_number as '料號',
                p.part_name as '料件名稱',
                p.unit as '單位',
                COALESCE(ic.previous_quantity, ic.system_quantity) as '上次盤點',
                ic.actual_quantity as '實際盤點',
                ic.difference as '差異',
                CASE
                    WHEN ic.difference > 0 THEN '盤盈'
                    WHEN ic.difference < 0 THEN '盤虧'
                    ELSE '相符'
                END as '狀態',
                ic.note as '備註',
                ic.created_by as '盤點人員',
                ic.created_at as '記錄時間'
            FROM inventory_checks ic
            JOIN parts p ON ic.part_id = p.id
            ${whereClause}
            ORDER BY ic.check_date DESC, ic.created_at DESC
        `);
        
        const data = stmt.all(...params);
        
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('盤點記錄');
        
        // 設定欄位標題
        worksheet.columns = [
            { header: '盤點日期', key: '盤點日期', width: 12 },
            { header: '料號', key: '料號', width: 15 },
            { header: '料件名稱', key: '料件名稱', width: 20 },
            { header: '單位', key: '單位', width: 10 },
            { header: '上次盤點', key: '上次盤點', width: 12 },
            { header: '實際盤點', key: '實際盤點', width: 12 },
            { header: '差異', key: '差異', width: 12 },
            { header: '狀態', key: '狀態', width: 10 },
            { header: '備註', key: '備註', width: 30 },
            { header: '盤點人員', key: '盤點人員', width: 15 },
            { header: '記錄時間', key: '記錄時間', width: 20 }
        ];
        
        // 添加資料
        data.forEach(row => {
            worksheet.addRow(row);
        });
        
        // 設定標題行樣式
        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF667EEA' }
        };
        worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        
        const buffer = await workbook.xlsx.writeBuffer();
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('盤點記錄.xlsx')}`);
        res.send(buffer);
        } catch (error) {
            logger.error('匯出盤點報表失敗:', error);
            flash(req, 'error', `匯出失敗：${error.message}`);
            res.redirect('/inventory/check/records');
        }
    });

    // Excel 匯出 - 料件列表
    app.get('/export/parts', async (req, res) => {
        try {
        const isAdmin = req.session.user && req.session.user.role === 'admin';
        const stmt = db.prepare(`
            SELECT
                p.part_number as '料號',
                p.part_name as '料件名稱',
                c.name as '類型',
                p.specification as '規格',
                p.barcode as '條碼',
                p.unit as '單位',
                p.sell_price as '售價',
                ${isAdmin ? "p.cost_price as '成本價'," : ''}
                p.created_at as '建立時間'
            FROM parts p
            LEFT JOIN categories c ON p.category_id = c.id
            ORDER BY p.part_number
        `);
        const data = stmt.all();

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('料件列表');

        // 設定欄位標題
        worksheet.columns = [
            { header: '料號', key: '料號', width: 15 },
            { header: '料件名稱', key: '料件名稱', width: 20 },
            { header: '類型', key: '類型', width: 15 },
            { header: '規格', key: '規格', width: 20 },
            { header: '條碼', key: '條碼', width: 20 },
            { header: '單位', key: '單位', width: 10 },
            { header: '售價', key: '售價', width: 12 },
            ...(isAdmin ? [{ header: '成本價', key: '成本價', width: 12 }] : []),
            { header: '建立時間', key: '建立時間', width: 20 }
        ];
        
        // 添加資料
        data.forEach(row => {
            worksheet.addRow(row);
        });
        
        // 設定標題行樣式
        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF4CAF50' }
        };
        worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        
        const buffer = await workbook.xlsx.writeBuffer();
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('料件列表.xlsx')}`);
        res.send(buffer);
        } catch (error) {
            logger.error('匯出料件列表失敗:', error);
            flash(req, 'error', `匯出失敗：${error.message}`);
            res.redirect('/parts');
        }
    });

    // Excel 匯出 - 出入庫記錄
    app.get('/export/transaction-records', async (req, res) => {
        try {
        logActivity(req, 'export', '匯出出入庫記錄', 'export', null);
        const { search, type, date_from, date_to, category_id } = req.query;

        let records = [];

        // 構建入庫記錄查詢
        let inboundQuery = `
            SELECT
                ir.inbound_date as '日期',
                CASE
                    WHEN ir.is_return = 1 THEN '歸還'
                    ELSE '入庫'
                END as '類型',
                p.part_number as '料號',
                p.part_name as '料件名稱',
                c.name as '料件類型',
                ir.quantity as '數量',
                p.unit as '單位',
                ir.note as '備註',
                ir.created_by as '操作人員',
                ir.created_at as '記錄時間',
                '' as '借測轉換',
                '' as '發票狀態',
                '' as '發票號碼'
            FROM inbound_records ir
            JOIN parts p ON ir.part_id = p.id
            LEFT JOIN categories c ON p.category_id = c.id
            WHERE 1=1
        `;
        let inboundParams = [];

        // 構建出庫記錄查詢
        let outboundQuery = `
            SELECT
                o.outbound_date as '日期',
                CASE
                    WHEN o.is_loan = 1 THEN '借測'
                    ELSE '出庫'
                END as '類型',
                p.part_number as '料號',
                p.part_name as '料件名稱',
                c.name as '料件類型',
                o.quantity as '數量',
                p.unit as '單位',
                o.note as '備註',
                o.created_by as '操作人員',
                o.created_at as '記錄時間',
                CASE
                    WHEN o.converted_from_loan = 1 THEN '是'
                    ELSE '否'
                END as '借測轉換',
                CASE
                    WHEN o.has_invoice = 1 THEN '已開發票'
                    ELSE '未開發票'
                END as '發票狀態',
                COALESCE(o.invoice_number, '') as '發票號碼'
            FROM outbound_records o
            JOIN parts p ON o.part_id = p.id
            LEFT JOIN categories c ON p.category_id = c.id
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

        // 料件類型
        if (category_id) {
            inboundQuery += ` AND p.category_id = ?`;
            inboundParams.push(category_id);
            outboundQuery += ` AND p.category_id = ?`;
            outboundParams.push(category_id);
        }

        // 類型條件
        if (type === 'inbound') {
            inboundQuery += ` AND (ir.is_return = 0 OR ir.is_return IS NULL)`;
        } else if (type === 'outbound') {
            outboundQuery += ` AND (o.is_loan = 0 OR o.is_loan IS NULL)`;
        } else if (type === 'return') {
            inboundQuery += ` AND ir.is_return = 1`;
        } else if (type === 'loan') {
            outboundQuery += ` AND o.is_loan = 1`;
        }
        
        // 執行查詢
        if (!type || type === 'inbound' || type === 'return') {
            const inboundStmt = db.prepare(inboundQuery);
            const inboundRecords = inboundStmt.all(...inboundParams);
            records = records.concat(inboundRecords);
        }
        
        if (!type || type === 'outbound' || type === 'loan') {
            const outboundStmt = db.prepare(outboundQuery);
            const outboundRecords = outboundStmt.all(...outboundParams);
            records = records.concat(outboundRecords);
        }
        
        // 排序
        records.sort((a, b) => {
            const dateCompare = new Date(b['日期']) - new Date(a['日期']);
            if (dateCompare !== 0) return dateCompare;
            return new Date(b['記錄時間']) - new Date(a['記錄時間']);
        });
        
        // 限制數量
        records = records.slice(0, 5000);
        
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('出入庫記錄');
        
        // 設定欄位標題
        worksheet.columns = [
            { header: '日期', key: '日期', width: 12 },
            { header: '類型', key: '類型', width: 10 },
            { header: '料號', key: '料號', width: 15 },
            { header: '料件名稱', key: '料件名稱', width: 25 },
            { header: '料件類型', key: '料件類型', width: 15 },
            { header: '數量', key: '數量', width: 10 },
            { header: '單位', key: '單位', width: 8 },
            { header: '備註', key: '備註', width: 30 },
            { header: '操作人員', key: '操作人員', width: 15 },
            { header: '借測轉換', key: '借測轉換', width: 10 },
            { header: '發票狀態', key: '發票狀態', width: 12 },
            { header: '發票號碼', key: '發票號碼', width: 20 },
            { header: '記錄時間', key: '記錄時間', width: 20 }
        ];
        
        // 添加資料
        records.forEach(row => {
            worksheet.addRow(row);
        });
        
        // 設定標題行樣式
        worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        worksheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF667EEA' }
        };
        worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
        
        // 設定資料行樣式
        records.forEach((row, index) => {
            const rowNum = index + 2;
            // 根據類型設定數量欄位顏色
            if (row['類型'] === '入庫' || row['類型'] === '歸還') {
                worksheet.getRow(rowNum).getCell('數量').font = { color: { argb: 'FF28A745' } };
            } else if (row['類型'] === '出庫' || row['類型'] === '借測') {
                worksheet.getRow(rowNum).getCell('數量').font = { color: { argb: 'FFDC3545' } };
            }
        });
        
        // 生成檔名
        const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
        const filename = `出入庫記錄_${dateStr}.xlsx`;
        
        const buffer = await workbook.xlsx.writeBuffer();
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
        res.send(buffer);
        } catch (error) {
            logger.error('匯出出入庫記錄失敗:', error);
            flash(req, 'error', `匯出失敗：${error.message}`);
            res.redirect('/transaction/records');
        }
    });

    // Excel 匯出 - 庫存
    app.get('/export/inventory', async (req, res) => {
        try {
        logActivity(req, 'export', '匯出庫存資料', 'export', null);
        const stmt = db.prepare(`
            SELECT 
                p.part_number as '料號',
                p.part_name as '料件名稱',
                c.name as '類型',
                p.specification as '規格',
                p.barcode as '條碼',
                (${physicalStockSql('p.id')}) as '庫存數量',
                p.unit as '單位'
            FROM parts p
            LEFT JOIN categories c ON p.category_id = c.id
            ORDER BY p.part_number
        `);
        const data = stmt.all();
        
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('庫存查詢');
        
        // 設定欄位標題
        worksheet.columns = [
            { header: '料號', key: '料號', width: 15 },
            { header: '料件名稱', key: '料件名稱', width: 20 },
            { header: '類型', key: '類型', width: 15 },
            { header: '規格', key: '規格', width: 20 },
            { header: '條碼', key: '條碼', width: 20 },
            { header: '庫存數量', key: '庫存數量', width: 12 },
            { header: '單位', key: '單位', width: 10 }
        ];
        
        // 添加資料
        data.forEach(row => {
            worksheet.addRow(row);
        });
        
        // 設定標題行樣式
        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF4CAF50' }
        };
        worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        
        const buffer = await workbook.xlsx.writeBuffer();
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('庫存查詢.xlsx')}`);
        res.send(buffer);
        } catch (error) {
            logger.error('匯出庫存資料失敗:', error);
            flash(req, 'error', `匯出失敗：${error.message}`);
            res.redirect('/');
        }
    });

    // Excel 匯入範本下載
    app.get('/import/template', async (req, res) => {
        try {
        logActivity(req, 'view', '下載匯入範本', 'import', null);
        const workbook = new ExcelJS.Workbook();
        
        // 範本工作表
        const templateSheet = workbook.addWorksheet('料件匯入範本');
        templateSheet.columns = [
            { header: '料號', key: '料號', width: 15 },
            { header: '料件名稱', key: '料件名稱', width: 20 },
            { header: '規格', key: '規格', width: 20 },
            { header: '條碼', key: '條碼', width: 20 },
            { header: '單位', key: '單位', width: 10 },
            { header: '類型', key: '類型', width: 15 }
        ];
        
        templateSheet.addRow({
            '料號': 'A001',
            '料件名稱': '範例料件',
            '規格': '範例規格',
            '條碼': '1234567890123',
            '單位': '個',
            '類型': '電子元件'
        });
        
        // 設定標題行樣式
        templateSheet.getRow(1).font = { bold: true };
        templateSheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF4CAF50' }
        };
        templateSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        
        // 說明工作表
        const instructionSheet = workbook.addWorksheet('使用說明');
        instructionSheet.columns = [
            { header: '說明', key: '說明', width: 80 }
        ];
        
        const instructions = [
            '料件匯入範本使用說明',
            '',
            '必填欄位：',
            '  1. 料號：必須唯一，不能重複',
            '  2. 料件名稱：料件的名稱',
            '  3. 單位：單位名稱（如不存在會自動建立）',
            '',
            '選填欄位：',
            '  1. 規格：料件的規格說明',
            '  2. 條碼：料件的條碼（必須唯一）',
            '  3. 類型：類型名稱（如不存在會自動建立）',
            '',
            '注意事項：',
            '  - 如果類型不存在，系統會自動建立該類型',
            '  - 如果單位不存在，系統會自動建立該單位',
            '  - 重複的料號會被跳過',
            '  - 重複的條碼會被跳過'
        ];
        
        instructions.forEach(text => {
            instructionSheet.addRow({ '說明': text });
        });
        
        instructionSheet.getRow(1).font = { bold: true, size: 14 };
        
        const buffer = await workbook.xlsx.writeBuffer();
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('料件匯入範本.xlsx')}`);
        res.send(buffer);
        } catch (error) {
            logger.error('下載匯入範本失敗:', error);
            flash(req, 'error', `下載失敗：${error.message}`);
            res.redirect('/import');
        }
    });

    // Excel 匯入頁面
    app.get('/import', (req, res) => {
        logActivity(req, 'view', '查看匯入頁面', 'import', null);
        res.render('import', { title: PAGE_TITLE });
    });
    
    // Excel 匯入處理
    app.post('/import', upload.single('excelFile'), async (req, res) => {
        if (!req.file) {
            flash(req, 'error', '請選擇要匯入的檔案');
            return res.redirect('/import');
        }
        
        try {
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.readFile(req.file.path);
            const worksheet = workbook.getWorksheet(1); // 取得第一個工作表
            
            const data = [];
            worksheet.eachRow((row, rowNumber) => {
                if (rowNumber === 1) return; // 跳過標題行
                
                const rowData = {};
                row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                    const header = worksheet.getRow(1).getCell(colNumber).value;
                    if (header) {
                        rowData[header] = cell.value;
                    }
                });
                if (Object.keys(rowData).length > 0) {
                    data.push(rowData);
                }
            });
            
            // 獲取所有類型和單位
            const categoriesStmt = db.prepare('SELECT * FROM categories');
            const categories = categoriesStmt.all();
            let categoryMap = {};
            categories.forEach(cat => {
                categoryMap[cat.name] = cat.id;
            });
            
            const unitsStmt = db.prepare('SELECT * FROM units');
            const units = unitsStmt.all();
            let unitMap = {};
            units.forEach(unit => {
                unitMap[unit.name] = unit.name;
            });
            
            // 準備插入語句
            const insertCategoryStmt = db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)');
            const getCategoryStmt = db.prepare('SELECT id FROM categories WHERE name = ?');
            const insertUnitStmt = db.prepare('INSERT OR IGNORE INTO units (name, symbol) VALUES (?, ?)');
            
            let successCount = 0;
            let skipCount = 0;
            const errors = [];
            
            const insertStmt = db.prepare(`
                INSERT INTO parts (part_number, part_name, specification, unit, category_id, barcode)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            
            const transaction = db.transaction(() => {
                data.forEach((row, index) => {
                    try {
                        const partNumber = row['料號'] || row['part_number'];
                        const partName = row['料件名稱'] || row['part_name'] || row['名稱'];
                        const specification = row['規格'] || row['specification'] || null;
                        const barcode = row['條碼'] || row['barcode'] || null;
                        let unitName = row['單位'] || row['unit'] || '個';
                        const categoryName = row['類型'] || row['category'] || null;
                        
                        if (!partNumber || !partName) {
                            skipCount++;
                            errors.push(`第 ${index + 2} 行：缺少必填欄位（料號或料件名稱）`);
                            return;
                        }
                        
                        // 自動建立單位（如果不存在）
                        if (!unitMap[unitName]) {
                            insertUnitStmt.run(unitName, unitName);
                            unitMap[unitName] = unitName;
                        }
                        const unit = unitMap[unitName] || '個';
                        
                        // 自動建立類型（如果不存在）
                        let categoryId = null;
                        if (categoryName) {
                            if (!categoryMap[categoryName]) {
                                insertCategoryStmt.run(categoryName);
                                const newCategory = getCategoryStmt.get(categoryName);
                                if (newCategory) {
                                    categoryMap[categoryName] = newCategory.id;
                                    categoryId = newCategory.id;
                                }
                            } else {
                                categoryId = categoryMap[categoryName];
                            }
                        }
                        
                        insertStmt.run(
                            partNumber,
                            partName,
                            specification,
                            unit,
                            categoryId,
                            barcode
                        );
                        successCount++;
                    } catch (error) {
                        skipCount++;
                        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                            errors.push(`第 ${index + 2} 行：料號或條碼已存在`);
                        } else {
                            errors.push(`第 ${index + 2} 行：${error.message}`);
                        }
                    }
                });
            });
            
            transaction();
            
            // 刪除上傳的檔案
            fs.unlinkSync(req.file.path);
            
            if (successCount > 0) {
                flash(req, 'success', `成功匯入 ${successCount} 筆資料${skipCount > 0 ? `，跳過 ${skipCount} 筆` : ''}`);
            } else {
                flash(req, 'error', `匯入失敗：${errors.slice(0, 5).join('; ')}${errors.length > 5 ? '...' : ''}`);
            }
            
            res.redirect('/parts');
        } catch (error) {
            // 刪除上傳的檔案
            if (req.file && fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
            flash(req, 'error', `匯入失敗：${error.message}`);
            res.redirect('/import');
        }
    });
};
