// 庫存盤點（盤點事件、逐件核對、差異報表、調整）
const logger = require('../lib/logger');

module.exports = function mountInventoryCheckRoutes(ctx) {
    const { app, db, config, flash, logActivity, physicalStockSql } = ctx;
    const PAGE_TITLE = config.PAGE_TITLE;

    app.get('/inventory/check/sessions', (req, res) => {
        logActivity(req, 'view', '查看盤點事件列表', 'inventory_check_sessions', null);
        const stmt = db.prepare(`
            SELECT
                ics.id, ics.session_date, ics.session_name, ics.status, ics.created_by, ics.note,
                datetime(ics.completed_at, '+8 hours') as completed_at,
                datetime(ics.created_at, '+8 hours') as created_at,
                COUNT(DISTINCT ic.part_id) as item_count,
                COUNT(DISTINCT CASE WHEN ic.difference != 0 THEN ic.id END) as difference_count
            FROM inventory_check_sessions ics
            LEFT JOIN inventory_checks ic ON ics.id = ic.session_id
            GROUP BY ics.id
            ORDER BY ics.session_date DESC, ics.created_at DESC
        `);
        
        const sessions = stmt.all();
        res.render('inventory_check_sessions', { 
            sessions, 
            user: req.session.user, 
            title: PAGE_TITLE 
        });
    });
    
    // 盤點事件管理 - 創建新盤點事件
    app.post('/inventory/check/sessions/create', (req, res) => {
        const { session_date, session_name, note } = req.body;
        const created_by = req.session.user ? (req.session.user.full_name || req.session.user.username) : '系統';
        
        try {
            if (!session_date) {
                flash(req, 'error', '請選擇盤點日期！');
                return res.redirect('/inventory/check/sessions');
            }
            
            // 檢查該日期是否已有盤點事件
            const checkStmt = db.prepare('SELECT id FROM inventory_check_sessions WHERE session_date = ?');
            const existing = checkStmt.get(session_date);
            
            if (existing) {
                flash(req, 'error', '該日期已存在盤點事件！');
                return res.redirect('/inventory/check/sessions');
            }
            
            const stmt = db.prepare(`
                INSERT INTO inventory_check_sessions (session_date, session_name, status, created_by, note)
                VALUES (?, ?, 'in_progress', ?, ?)
            `);
            const result = stmt.run(session_date, session_name || `${session_date} 盤點`, created_by, note || null);
            
            logActivity(req, 'create', `創建盤點事件：${session_name || session_date}`, 'inventory_check_session', result.lastInsertRowid);
            flash(req, 'success', '盤點事件創建成功！');
            res.redirect(`/inventory/check?session_date=${session_date}`);
        } catch (error) {
            if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                flash(req, 'error', '該日期已存在盤點事件！');
            } else {
                flash(req, 'error', `創建失敗：${error.message}`);
            }
            res.redirect('/inventory/check/sessions');
        }
    });
    
    // 盤點事件管理 - 完成盤點事件
    app.post('/inventory/check/sessions/:id/complete', (req, res) => {
        const { id } = req.params;
        const completed_by = req.session.user ? (req.session.user.full_name || req.session.user.username) : '系統';
        
        try {
            const sessionStmt = db.prepare('SELECT session_name FROM inventory_check_sessions WHERE id = ?');
            const session = sessionStmt.get(id);
            const sessionName = session ? session.session_name : '未知';
            
            const stmt = db.prepare(`
                UPDATE inventory_check_sessions 
                SET status = 'completed', completed_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `);
            stmt.run(id);
            
            logActivity(req, 'update', `完成盤點事件：${sessionName}`, 'inventory_check_session', parseInt(id));
            flash(req, 'success', '盤點事件已完成！');
            res.redirect('/inventory/check/sessions');
        } catch (error) {
            flash(req, 'error', `完成失敗：${error.message}`);
            res.redirect('/inventory/check/sessions');
        }
    });
    
    // 庫存盤點頁面（基於盤點事件）
    app.get('/inventory/check', (req, res) => {
        const { session_date } = req.query;
        
        // 獲取當前進行中的盤點事件，或使用指定的日期
        let currentSession = null;
        if (session_date) {
            const sessionStmt = db.prepare('SELECT * FROM inventory_check_sessions WHERE session_date = ?');
            currentSession = sessionStmt.get(session_date);
        } else {
            // 獲取最新的進行中事件
            const activeSessionStmt = db.prepare(`
                SELECT * FROM inventory_check_sessions 
                WHERE status = 'in_progress' 
                ORDER BY session_date DESC 
                LIMIT 1
            `);
            currentSession = activeSessionStmt.get();
        }
        
        // 獲取所有盤點事件列表（用於選擇）
        const sessionsStmt = db.prepare(`
            SELECT * FROM inventory_check_sessions 
            ORDER BY session_date DESC 
            LIMIT 20
        `);
        const allSessions = sessionsStmt.all();
        
        // 如果沒有進行中的盤點事件，提示創建
        if (!currentSession) {
            // 仍然顯示料件列表，但提示需要創建盤點事件
            const partsStmt = db.prepare(`
                SELECT 
                    p.id,
                    p.part_number,
                    p.part_name,
                    p.specification,
                    p.unit,
                    p.barcode,
                    c.name as category_name,
                    COALESCE(p.is_active, 1) as is_active,
                    (${physicalStockSql('p.id')}) as system_quantity
                FROM parts p
                LEFT JOIN categories c ON p.category_id = c.id
                WHERE COALESCE(p.is_active, 1) = 1
                ORDER BY p.part_number
            `);
            const parts = partsStmt.all();
            const today = new Date().toISOString().split('T')[0];
            
            return res.render('inventory_check', { 
                parts, 
                today, 
                currentSession: null,
                allSessions: [],
                user: req.session.user, 
                title: PAGE_TITLE 
            });
        }
        
        // 獲取該盤點事件中已盤點的料件
        const checkedPartsStmt = db.prepare(`
            SELECT part_id, actual_quantity 
            FROM inventory_checks 
            WHERE session_id = ?
        `);
        const checkedParts = checkedPartsStmt.all(currentSession.id);
        const checkedPartsMap = {};
        checkedParts.forEach(cp => {
            checkedPartsMap[cp.part_id] = cp.actual_quantity;
        });
        
        // 獲取所有料件，並查找上次盤點的數量
        const partsStmt = db.prepare(`
            SELECT 
                p.id,
                p.part_number,
                p.part_name,
                p.specification,
                p.unit,
                p.barcode,
                c.name as category_name,
                (SELECT actual_quantity 
                 FROM inventory_checks ic2
                 JOIN inventory_check_sessions ics2 ON ic2.session_id = ics2.id
                 WHERE ic2.part_id = p.id 
                   AND ics2.session_date < ?
                   AND ics2.status = 'completed'
                 ORDER BY ics2.session_date DESC 
                 LIMIT 1) as previous_check_quantity
            FROM parts p
            LEFT JOIN categories c ON p.category_id = c.id
            ORDER BY p.part_number
        `);
        const parts = partsStmt.all(currentSession.session_date);
        
        // 如果沒有上次盤點記錄，使用系統庫存作為基準
        parts.forEach(part => {
            if (!part.previous_check_quantity && part.previous_check_quantity !== 0) {
                const stockStmt = db.prepare(`
                    SELECT 
                        (${physicalStockSql('?')}) as system_quantity
                `);
                const stock = stockStmt.get(part.id, part.id);
                part.previous_check_quantity = stock ? stock.system_quantity : 0;
            }
            // 如果本次已盤點，使用已盤點的數量
            if (checkedPartsMap[part.id] !== undefined) {
                part.current_check_quantity = checkedPartsMap[part.id];
            }
        });
        
        const today = new Date().toISOString().split('T')[0];
        res.render('inventory_check', { 
            parts, 
            today, 
            currentSession,
            allSessions,
            user: req.session.user, 
            title: PAGE_TITLE 
        });
    });
    
    // 批量盤點處理（連續掃描模式）
    app.post('/inventory/check/batch', (req, res) => {
        const { session_id, session_date, items, auto_adjust } = req.body;
        const created_by = req.session.user ? (req.session.user.full_name || req.session.user.username) : '系統';
        const shouldAutoAdjust = auto_adjust === 'true';
        
        try {
            // 解析批量盤點項目
            let batchItems = [];
            try {
                batchItems = typeof items === 'string' ? JSON.parse(items) : items;
            } catch (e) {
                flash(req, 'error', '盤點資料格式錯誤！');
                return res.redirect('/inventory/check');
            }
            
            if (!Array.isArray(batchItems) || batchItems.length === 0) {
                flash(req, 'error', '盤點清單為空！');
                return res.redirect('/inventory/check');
            }
            
            // 驗證盤點事件是否存在
            let currentSessionId = session_id ? parseInt(session_id) : null;
            
            if (!currentSessionId && session_date) {
                const sessionStmt = db.prepare('SELECT id FROM inventory_check_sessions WHERE session_date = ?');
                let session = sessionStmt.get(session_date);
                
                if (!session) {
                    const createSessionStmt = db.prepare(`
                        INSERT INTO inventory_check_sessions (session_date, session_name, status, created_by)
                        VALUES (?, ?, 'in_progress', ?)
                    `);
                    const sessionResult = createSessionStmt.run(session_date, `${session_date} 盤點`, created_by);
                    currentSessionId = sessionResult.lastInsertRowid;
                } else {
                    currentSessionId = session.id;
                }
            }
            
            if (!currentSessionId) {
                flash(req, 'error', '請先創建盤點事件！');
                return res.redirect('/inventory/check/sessions');
            }
            
            // 獲取盤點事件的日期
            const sessionDateStmt = db.prepare('SELECT session_date FROM inventory_check_sessions WHERE id = ?');
            const sessionDate = sessionDateStmt.get(currentSessionId).session_date;
            
            let successCount = 0;
            let errorCount = 0;
            let adjustedCount = 0;
            
            // 使用事務處理批量盤點
            const transaction = db.transaction(() => {
                for (const item of batchItems) {
                    try {
                        const { part_id, actual_quantity, previous_quantity } = item;
                        const actualQty = parseInt(actual_quantity) || 0;
                        const prevQty = parseInt(previous_quantity) || 0;
                        const difference = actualQty - prevQty;
                        
                        // 獲取當前系統庫存（物理庫存）
                        const stockStmt = db.prepare(`SELECT (${physicalStockSql('?')}) as system_quantity`);
                        const stock = stockStmt.get(part_id, part_id);
                        const systemQuantity = stock ? stock.system_quantity : 0;
                        
                        // 檢查該料件在本次盤點事件中是否已盤點
                        const existingCheckStmt = db.prepare(`
                            SELECT id FROM inventory_checks 
                            WHERE session_id = ? AND part_id = ?
                        `);
                        const existingCheck = existingCheckStmt.get(currentSessionId, part_id);
                        
                        if (existingCheck) {
                            // 更新現有記錄
                            const updateStmt = db.prepare(`
                                UPDATE inventory_checks 
                                SET system_quantity = ?, previous_quantity = ?, actual_quantity = ?, difference = ?, created_by = ?
                                WHERE id = ?
                            `);
                            updateStmt.run(systemQuantity, prevQty, actualQty, difference, created_by, existingCheck.id);
                        } else {
                            // 插入新記錄
                            const checkStmt = db.prepare(`
                                INSERT INTO inventory_checks (session_id, part_id, check_date, system_quantity, previous_quantity, actual_quantity, difference, note, created_by, is_adjusted)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            `);
                            checkStmt.run(
                                currentSessionId, 
                                part_id, 
                                sessionDate,
                                systemQuantity,
                                prevQty, 
                                actualQty, 
                                difference, 
                                null, 
                                created_by, 
                                shouldAutoAdjust && difference !== 0 ? 1 : 0
                            );
                        }
                        
                        // 如果有差異且選擇自動調整，則自動調整庫存
                        if (difference !== 0 && shouldAutoAdjust) {
                            let adjustmentNote = '';
                            if (difference > 0) {
                                const inboundStmt = db.prepare(`
                                    INSERT INTO inbound_records (part_id, quantity, inbound_date, note, is_return, created_by)
                                    VALUES (?, ?, ?, ?, 0, ?)
                                `);
                                adjustmentNote = `批量盤點調整（盤盈 ${difference}，相較上次盤點 ${prevQty}）`;
                                inboundStmt.run(part_id, difference, sessionDate, adjustmentNote, created_by);
                            } else {
                                const outboundStmt = db.prepare(`
                                    INSERT INTO outbound_records (part_id, quantity, outbound_date, note, is_loan, created_by)
                                    VALUES (?, ?, ?, ?, 0, ?)
                                `);
                                adjustmentNote = `批量盤點調整（盤虧 ${Math.abs(difference)}，相較上次盤點 ${prevQty}）`;
                                outboundStmt.run(part_id, Math.abs(difference), sessionDate, adjustmentNote, created_by);
                            }
                            
                            // 更新盤點記錄的調整資訊
                            const updateStmt = db.prepare(`
                                UPDATE inventory_checks 
                                SET adjustment_note = ?, adjusted_at = CURRENT_TIMESTAMP, adjusted_by = ?, is_adjusted = 1
                                WHERE session_id = ? AND part_id = ?
                            `);
                            updateStmt.run(adjustmentNote, created_by, currentSessionId, part_id);
                            adjustedCount++;
                        }
                        
                        successCount++;
                    } catch (error) {
                        logger.error(`處理料件 ${item.part_id} 盤點記錄失敗:`, error);
                        errorCount++;
                    }
                }
            });
            
            transaction();
            
            logActivity(req, 'update', `批量盤點：成功 ${successCount} 項${errorCount > 0 ? `，失敗 ${errorCount} 項` : ''}${shouldAutoAdjust && adjustedCount > 0 ? `，已自動調整 ${adjustedCount} 項` : ''}`, 'inventory_check', currentSessionId);
            
            // 返回成功訊息
            if (errorCount === 0) {
                let message = `批量盤點提交成功！共處理 ${successCount} 項料件。`;
                if (shouldAutoAdjust && adjustedCount > 0) {
                    message += `已自動調整 ${adjustedCount} 項差異。`;
                } else if (adjustedCount === 0 && shouldAutoAdjust) {
                    message += '所有項目均無差異，無需調整。';
                } else {
                    message += '請前往「盤點差異報表」查看並手動調整差異。';
                }
                flash(req, 'success', message);
            } else {
                flash(req, 'warning', `批量盤點提交完成！成功 ${successCount} 項，失敗 ${errorCount} 項。`);
            }
            
            res.redirect(`/inventory/check?session_date=${sessionDate}`);
        } catch (error) {
            flash(req, 'error', `批量盤點失敗：${error.message}`);
            res.redirect('/inventory/check');
        }
    });
    
    // 盤點處理（基於盤點事件，比較本次與上次盤點結果）（單項模式，保留以備用）
    app.post('/inventory/check', (req, res) => {
        const { part_id, session_id, session_date, actual_quantity, note, auto_adjust } = req.body;
        const created_by = req.session.user ? (req.session.user.full_name || req.session.user.username) : '系統';
        const shouldAutoAdjust = auto_adjust === 'on' || auto_adjust === 'true';
        
        try {
            // 驗證盤點事件是否存在
            let currentSessionId = session_id ? parseInt(session_id) : null;
            
            if (!currentSessionId && session_date) {
                // 根據日期查找或創建盤點事件
                const sessionStmt = db.prepare('SELECT id FROM inventory_check_sessions WHERE session_date = ?');
                let session = sessionStmt.get(session_date);
                
                if (!session) {
                    // 創建新的盤點事件
                    const createSessionStmt = db.prepare(`
                        INSERT INTO inventory_check_sessions (session_date, session_name, status, created_by)
                        VALUES (?, ?, 'in_progress', ?)
                    `);
                    const sessionResult = createSessionStmt.run(
                        session_date, 
                        `${session_date} 盤點`, 
                        created_by
                    );
                    currentSessionId = sessionResult.lastInsertRowid;
                } else {
                    currentSessionId = session.id;
                }
            }
            
            if (!currentSessionId) {
                flash(req, 'error', '請先創建盤點事件！');
                return res.redirect('/inventory/check/sessions');
            }
            
            // 獲取盤點事件的日期
            const sessionDateStmt = db.prepare('SELECT session_date FROM inventory_check_sessions WHERE id = ?');
            const sessionDate = sessionDateStmt.get(currentSessionId).session_date;
            
            // 獲取上次盤點的實際數量（與上次盤點事件比較）
            const previousCheckStmt = db.prepare(`
                SELECT ic.actual_quantity, ics.session_date
                FROM inventory_checks ic
                JOIN inventory_check_sessions ics ON ic.session_id = ics.id
                WHERE ic.part_id = ? 
                  AND ics.id != ?
                  AND ics.status = 'completed'
                ORDER BY ics.session_date DESC
                LIMIT 1
            `);
            const previousCheck = previousCheckStmt.get(part_id, currentSessionId);
            
            let previousQuantity = null;
            if (previousCheck) {
                previousQuantity = previousCheck.actual_quantity;
            } else {
                // 如果沒有上次盤點記錄，使用系統庫存作為基準（首次盤點）
                const stockStmt = db.prepare(`
                    SELECT 
                        (${physicalStockSql('?')}) as system_quantity
                `);
                const stock = stockStmt.get(part_id, part_id);
                previousQuantity = stock ? stock.system_quantity : 0;
            }
            
            const actualQty = parseInt(actual_quantity);
            const difference = actualQty - previousQuantity;
            
            // 檢查該料件在本次盤點事件中是否已盤點
            const existingCheckStmt = db.prepare(`
                SELECT id FROM inventory_checks 
                WHERE session_id = ? AND part_id = ?
            `);
            const existingCheck = existingCheckStmt.get(currentSessionId, part_id);
            
            let checkRecordId;
            if (existingCheck) {
                // 獲取當前系統庫存（用於向後兼容）
                const stockStmt = db.prepare(`
                    SELECT 
                        (${physicalStockSql('?')}) as system_quantity
                `);
                const stock = stockStmt.get(part_id, part_id);
                const systemQuantity = stock ? stock.system_quantity : 0;
                
                // 更新現有記錄（同時更新 system_quantity 以確保向後兼容）
                const updateStmt = db.prepare(`
                    UPDATE inventory_checks 
                    SET system_quantity = ?, previous_quantity = ?, actual_quantity = ?, difference = ?, note = ?, created_by = ?
                    WHERE id = ?
                `);
                updateStmt.run(systemQuantity, previousQuantity, actualQty, difference, note || null, created_by, existingCheck.id);
                checkRecordId = existingCheck.id;
            } else {
                // 獲取當前系統庫存（用於向後兼容，填充 system_quantity 欄位）
                const stockStmt = db.prepare(`
                    SELECT 
                        (${physicalStockSql('?')}) as system_quantity
                `);
                const stock = stockStmt.get(part_id, part_id);
                const systemQuantity = stock ? stock.system_quantity : 0;
                
                // 插入新記錄（同時提供 system_quantity 和 previous_quantity 以確保向後兼容）
                const checkStmt = db.prepare(`
                    INSERT INTO inventory_checks (session_id, part_id, check_date, system_quantity, previous_quantity, actual_quantity, difference, note, created_by, is_adjusted)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);
                const checkId = checkStmt.run(
                    currentSessionId, 
                    part_id, 
                    sessionDate,
                    systemQuantity,  // 系統庫存（用於向後兼容）
                    previousQuantity,  // 上次盤點數量（新的比較基準）
                    actualQty, 
                    difference, 
                    note || null, 
                    created_by, 
                    shouldAutoAdjust ? 1 : 0
                );
                checkRecordId = checkId.lastInsertRowid;
            }
            
            // 如果有差異且選擇自動調整，則自動調整庫存
            if (difference !== 0 && shouldAutoAdjust) {
                let adjustmentNote = '';
                if (difference > 0) {
                    // 盤盈：創建入庫記錄
                    const inboundStmt = db.prepare(`
                        INSERT INTO inbound_records (part_id, quantity, inbound_date, note, is_return, created_by)
                        VALUES (?, ?, ?, ?, 0, ?)
                    `);
                    adjustmentNote = `盤點調整（盤盈 ${difference}，相較上次盤點 ${previousQuantity}）：${note || ''}`.trim();
                    inboundStmt.run(part_id, difference, sessionDate, adjustmentNote, created_by);
                } else {
                    // 盤虧：創建出庫記錄
                    const outboundStmt = db.prepare(`
                        INSERT INTO outbound_records (part_id, quantity, outbound_date, note, is_loan, created_by)
                        VALUES (?, ?, ?, ?, 0, ?)
                    `);
                    adjustmentNote = `盤點調整（盤虧 ${Math.abs(difference)}，相較上次盤點 ${previousQuantity}）：${note || ''}`.trim();
                    outboundStmt.run(part_id, Math.abs(difference), sessionDate, adjustmentNote, created_by);
                }
                
                // 更新盤點記錄的調整資訊
                const updateStmt = db.prepare(`
                    UPDATE inventory_checks 
                    SET adjustment_note = ?, adjusted_at = CURRENT_TIMESTAMP, adjusted_by = ?, is_adjusted = 1
                    WHERE id = ?
                `);
                updateStmt.run(adjustmentNote, created_by, checkRecordId);
                
                flash(req, 'success', `盤點記錄成功！已自動調整庫存（${difference > 0 ? '盤盈' : '盤虧'} ${Math.abs(difference)}，相較上次盤點 ${previousQuantity}）`);
            } else if (difference !== 0) {
                flash(req, 'success', `盤點記錄成功！發現差異：${difference > 0 ? '盤盈' : '盤虧'} ${Math.abs(difference)}（相較上次盤點 ${previousQuantity}），請前往「盤點差異報表」進行手動調整。`);
            } else {
                flash(req, 'success', `盤點記錄成功！與上次盤點相符（數量：${actualQty}，上次：${previousQuantity}）`);
            }
            
            // 重定向回盤點頁面，保持盤點事件
            res.redirect(`/inventory/check?session_date=${sessionDate}`);
        } catch (error) {
            flash(req, 'error', `盤點失敗：${error.message}`);
            res.redirect('/inventory/check');
        }
    });
    
    // 盤點記錄列表
    app.get('/inventory/check/records', (req, res) => {
        logActivity(req, 'view', '查看盤點記錄', 'inventory_check_records', null);
        const { search, date_from, date_to, session_id } = req.query;
        
        let whereConditions = [];
        let params = [];
        
        // 搜尋條件
        if (search && search.trim()) {
            whereConditions.push(`(p.part_number LIKE ? OR p.part_name LIKE ? OR p.barcode LIKE ?)`);
            const searchTerm = `%${search.trim()}%`;
            params.push(searchTerm, searchTerm, searchTerm);
        }
        
        // 盤點事件篩選
        if (session_id && session_id !== '') {
            whereConditions.push(`ic.session_id = ?`);
            params.push(session_id);
        }
        
        // 日期範圍（基於盤點事件日期，如果沒有盤點事件則使用 check_date）
        if (date_from) {
            whereConditions.push(`COALESCE(ics.session_date, ic.check_date) >= ?`);
            params.push(date_from);
        }
        if (date_to) {
            whereConditions.push(`COALESCE(ics.session_date, ic.check_date) <= ?`);
            params.push(date_to);
        }
        
        const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
        
        const stmt = db.prepare(`
            SELECT 
                ic.id,
                ic.session_id,
                ics.session_date,
                ics.session_name,
                ics.status as session_status,
                ic.check_date,
                p.part_number,
                p.part_name,
                p.unit,
                COALESCE(ic.previous_quantity, ic.system_quantity) as previous_quantity,
                ic.actual_quantity,
                ic.difference,
                ic.note,
                ic.created_by,
                ic.is_adjusted,
                ic.adjustment_note,
                datetime(ic.adjusted_at, '+8 hours') as adjusted_at,
                ic.adjusted_by,
                datetime(ic.created_at, '+8 hours') as created_at
            FROM inventory_checks ic
            JOIN parts p ON ic.part_id = p.id
            LEFT JOIN inventory_check_sessions ics ON ic.session_id = ics.id
            ${whereClause}
            ORDER BY COALESCE(ics.session_date, ic.check_date) DESC, ic.created_at DESC
            LIMIT 500
        `);
        
        const records = stmt.all(...params);
        
        // 獲取所有盤點事件用於下拉選單
        const sessionsStmt = db.prepare(`
            SELECT DISTINCT ics.id, ics.session_date, ics.session_name, ics.status
            FROM inventory_check_sessions ics
            LEFT JOIN inventory_checks ic ON ics.id = ic.session_id
            WHERE ic.id IS NOT NULL
            ORDER BY ics.session_date DESC
            LIMIT 50
        `);
        const checkSessions = sessionsStmt.all();
        
        res.render('inventory_check_records', { 
            records, 
            checkSessions,
            search: search || '',
            date_from: date_from || '',
            date_to: date_to || '',
            session_id: session_id || '',
            user: req.session.user, 
            title: PAGE_TITLE 
        });
    });
    
    // 盤點差異報表（只顯示有差異的記錄，顯示本次與上次盤點的差異）
    app.get('/inventory/check/differences', (req, res) => {
        logActivity(req, 'view', '查看盤點差異報表', 'inventory_check_differences', null);
        const { search, date_from, date_to, session_id } = req.query;
        
        let whereConditions = ['ic.difference != 0'];  // 只顯示有差異的記錄
        let params = [];
        
        // 搜尋條件
        if (search && search.trim()) {
            whereConditions.push(`(p.part_number LIKE ? OR p.part_name LIKE ? OR p.barcode LIKE ?)`);
            const searchTerm = `%${search.trim()}%`;
            params.push(searchTerm, searchTerm, searchTerm);
        }
        
        // 盤點事件篩選
        if (session_id) {
            whereConditions.push(`ic.session_id = ?`);
            params.push(session_id);
        }
        
        // 日期範圍（基於盤點事件日期）
        if (date_from) {
            whereConditions.push(`ics.session_date >= ?`);
            params.push(date_from);
        }
        if (date_to) {
            whereConditions.push(`ics.session_date <= ?`);
            params.push(date_to);
        }
        
        const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
        
        // 獲取所有盤點事件列表（用於下拉選單）
        const sessionsStmt = db.prepare(`
            SELECT DISTINCT ics.id, ics.session_date, ics.session_name, ics.status
            FROM inventory_check_sessions ics
            JOIN inventory_checks ic ON ics.id = ic.session_id
            WHERE ic.difference != 0 
            ORDER BY ics.session_date DESC 
            LIMIT 50
        `);
        const checkSessions = sessionsStmt.all();
        
        // 獲取差異記錄（關聯盤點事件）
        const stmt = db.prepare(`
            SELECT 
                ic.id,
                ic.session_id,
                ics.session_date,
                ics.session_name,
                ics.status as session_status,
                p.part_number,
                p.part_name,
                p.unit,
                ic.previous_quantity,
                ic.actual_quantity,
                ic.difference,
                ic.note,
                ic.created_by,
                ic.is_adjusted,
                ic.adjustment_note,
                datetime(ic.adjusted_at, '+8 hours') as adjusted_at,
                ic.adjusted_by,
                datetime(ic.created_at, '+8 hours') as created_at
            FROM inventory_checks ic
            JOIN parts p ON ic.part_id = p.id
            LEFT JOIN inventory_check_sessions ics ON ic.session_id = ics.id
            ${whereClause}
            ORDER BY ics.session_date DESC, ABS(ic.difference) DESC, ic.created_at DESC
            LIMIT 500
        `);
        
        const records = stmt.all(...params);
        
        // 統計資訊
        const stats = {
            total: records.length,
            positive: records.filter(r => r.difference > 0).length,
            negative: records.filter(r => r.difference < 0).length,
            adjusted: records.filter(r => r.is_adjusted === 1).length,
            pending: records.filter(r => r.is_adjusted === 0).length,
            total_positive_diff: records.filter(r => r.difference > 0).reduce((sum, r) => sum + r.difference, 0),
            total_negative_diff: Math.abs(records.filter(r => r.difference < 0).reduce((sum, r) => sum + r.difference, 0))
        };
        
        res.render('inventory_check_differences', { 
            records, 
            checkSessions,
            stats,
            search: search || '',
            date_from: date_from || '',
            date_to: date_to || '',
            session_id: session_id || '',
            user: req.session.user, 
            title: PAGE_TITLE 
        });
    });
    
    // 手動調整盤點差異（基於盤點事件）
    app.post('/inventory/check/adjust/:id', (req, res) => {
        const { id } = req.params;
        const { adjustment_note } = req.body;
        const adjusted_by = req.session.user ? (req.session.user.full_name || req.session.user.username) : '系統';
        
        try {
            // 獲取盤點記錄（關聯盤點事件）
            const checkStmt = db.prepare(`
                SELECT ic.*, ics.session_date 
                FROM inventory_checks ic
                LEFT JOIN inventory_check_sessions ics ON ic.session_id = ics.id
                WHERE ic.id = ?
            `);
            const checkRecord = checkStmt.get(id);
            
            if (!checkRecord) {
                flash(req, 'error', '盤點記錄不存在！');
                return res.redirect('/inventory/check/differences');
            }
            
            // 如果已經調整過，不允許再次調整
            if (checkRecord.is_adjusted === 1) {
                flash(req, 'error', '此盤點記錄已經調整過，無法重複調整！');
                return res.redirect('/inventory/check/differences');
            }
            
            const difference = checkRecord.difference;
            const sessionDate = checkRecord.session_date || checkRecord.check_date;
            const partId = checkRecord.part_id;
            const note = checkRecord.note || '';
            const previousQuantity = checkRecord.previous_quantity || 0;
            
            // 根據差異調整庫存
            if (difference > 0) {
                // 盤盈：創建入庫記錄
                const inboundStmt = db.prepare(`
                    INSERT INTO inbound_records (part_id, quantity, inbound_date, note, is_return, created_by)
                    VALUES (?, ?, ?, ?, 0, ?)
                `);
                const adjustmentNote = `盤點調整（盤盈 ${difference}，相較上次盤點 ${previousQuantity}）：${note ? note + '；' : ''}${adjustment_note || ''}`.trim();
                inboundStmt.run(partId, difference, sessionDate, adjustmentNote, adjusted_by);
            } else if (difference < 0) {
                // 盤虧：創建出庫記錄
                const outboundStmt = db.prepare(`
                    INSERT INTO outbound_records (part_id, quantity, outbound_date, note, is_loan, created_by)
                    VALUES (?, ?, ?, ?, 0, ?)
                `);
                const adjustmentNote = `盤點調整（盤虧 ${Math.abs(difference)}，相較上次盤點 ${previousQuantity}）：${note ? note + '；' : ''}${adjustment_note || ''}`.trim();
                outboundStmt.run(partId, Math.abs(difference), sessionDate, adjustmentNote, adjusted_by);
            }
            
            // 更新盤點記錄的調整狀態
            const updateStmt = db.prepare(`
                UPDATE inventory_checks 
                SET is_adjusted = 1, 
                    adjustment_note = ?, 
                    adjusted_at = CURRENT_TIMESTAMP, 
                    adjusted_by = ?
                WHERE id = ?
            `);
            const finalAdjustmentNote = `${note ? note + '；' : ''}${adjustment_note || '手動調整庫存（相較上次盤點）'}`.trim();
            updateStmt.run(finalAdjustmentNote, adjusted_by, id);
            
            const partStmt = db.prepare('SELECT part_number, part_name FROM parts WHERE id = ?');
            const part = partStmt.get(partId);
            const partInfo = part ? `${part.part_number} - ${part.part_name}` : `料件ID: ${partId}`;
            
            logActivity(req, 'adjust', `調整盤點差異：${partInfo}，${difference > 0 ? '盤盈' : '盤虧'} ${Math.abs(difference)}`, 'inventory_check', parseInt(id));
            flash(req, 'success', `盤點差異調整成功！${difference > 0 ? '盤盈' : '盤虧'} ${Math.abs(difference)}（相較上次盤點 ${previousQuantity}）已調整至庫存。`);
            res.redirect('/inventory/check/differences');
        } catch (error) {
            flash(req, 'error', `調整失敗：${error.message}`);
            res.redirect('/inventory/check/differences');
        }
    });
};
