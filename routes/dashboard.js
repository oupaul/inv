// 庫存儀表板（首頁）
module.exports = function mountDashboardRoutes(ctx) {
    const { app, db, config, ownedStockSql, loanedQtySql, physicalStockSql } = ctx;
    const PAGE_TITLE = config.PAGE_TITLE;

    app.get('/', (req, res) => {
        const { search, category_id } = req.query;
        
        let whereConditions = [];
        let params = [];
        
        if (search && search.trim()) {
            whereConditions.push(`(p.part_number LIKE ? OR p.part_name LIKE ? OR p.barcode LIKE ? OR c.name LIKE ?)`);
            const searchTerm = `%${search.trim()}%`;
            params.push(searchTerm, searchTerm, searchTerm, searchTerm);
        }
        
        if (category_id && category_id !== '') {
            whereConditions.push(`p.category_id = ?`);
            params.push(category_id);
        }
        
        // 添加 is_active 條件
        whereConditions.push(`COALESCE(p.is_active, 1) = 1`);
        
        const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
        
        const stmt = db.prepare(`
            SELECT 
                p.id,
                p.part_number,
                p.part_name,
                p.specification,
                p.unit,
                p.barcode,
                p.min_stock,
                p.image_path,
                c.name as category_name,
                COALESCE(p.is_active, 1) as is_active,
                (${ownedStockSql('p.id')}) as total_quantity,
                (${loanedQtySql('p.id')}) as loaned_quantity
            FROM parts p
            LEFT JOIN categories c ON p.category_id = c.id
            ${whereClause}
            ORDER BY p.part_number
        `);
        
        const inventory = stmt.all(...params);
    
        // 取得所有有效借出記錄（依料件分組，用於儀錶板顯示借出對象）
        const loanDetailsStmt = db.prepare(`
            SELECT
                o.part_id,
                o.note,
                o.outbound_date,
                o.loan_due_date,
                o.created_by,
                o.quantity,
                o.quantity - COALESCE(SUM(i.quantity), 0) as remaining_quantity
            FROM outbound_records o
            LEFT JOIN inbound_records i ON i.return_outbound_id = o.id
            WHERE o.is_loan = 1
            GROUP BY o.id
            HAVING remaining_quantity > 0
            ORDER BY o.outbound_date DESC
        `);
        const loanDetailsRows = loanDetailsStmt.all();
        const loanDetailsByPart = {};
        loanDetailsRows.forEach(row => {
            if (!loanDetailsByPart[row.part_id]) loanDetailsByPart[row.part_id] = [];
            loanDetailsByPart[row.part_id].push(row);
        });
    
        // 低庫存警示（物理可用庫存 <= min_stock 且 min_stock > 0）
        const lowStockStmt = db.prepare(`
            SELECT * FROM (
                SELECT p.id, p.part_number, p.part_name, p.unit, COALESCE(p.min_stock, 0) as min_stock,
                    (${physicalStockSql('p.id')}) as current_stock
                FROM parts p
                WHERE COALESCE(p.is_active, 1) = 1 AND COALESCE(p.min_stock, 0) > 0
            ) sub
            WHERE current_stock <= min_stock
            ORDER BY (current_stock - min_stock) ASC
            LIMIT 20
        `);
        const lowStockItems = lowStockStmt.all();
    
        // 近期 10 筆交易記錄
        // - 與上方庫存列表套用相同的搜尋/類別篩選（連動）
        // - 單據號碼 = 記錄 id 加類型前綴（IN-/RT-/OUT-/LN-）
        // - 排序：日期 DESC，再以實際登錄時間 created_at DESC 做次要排序（避免同日記錄亂序）
        const recentConds = [];
        const recentParams = [];
        if (search && search.trim()) {
            recentConds.push(`(p.part_number LIKE ? OR p.part_name LIKE ? OR p.barcode LIKE ? OR c.name LIKE ?)`);
            const t = `%${search.trim()}%`;
            recentParams.push(t, t, t, t);
        }
        if (category_id && category_id !== '') {
            recentConds.push(`p.category_id = ?`);
            recentParams.push(category_id);
        }
        recentConds.push(`COALESCE(p.is_active, 1) = 1`);
        const recentWhere = 'WHERE ' + recentConds.join(' AND ');

        const recentTransStmt = db.prepare(`
            SELECT doc_no, transaction_date, type, part_number, part_name, quantity, created_by FROM (
                SELECT
                    (CASE WHEN ir.is_return = 1 THEN 'RT-' ELSE 'IN-' END || ir.id) AS doc_no,
                    ir.inbound_date AS transaction_date,
                    CASE WHEN ir.is_return = 1 THEN 'return' ELSE 'inbound' END AS type,
                    p.part_number, p.part_name, ir.quantity, ir.created_by,
                    ir.created_at AS created_at, ir.id AS rec_id
                FROM inbound_records ir
                JOIN parts p ON ir.part_id = p.id
                LEFT JOIN categories c ON p.category_id = c.id
                ${recentWhere}
                UNION ALL
                SELECT
                    (CASE WHEN o.is_loan = 1 THEN 'LN-' ELSE 'OUT-' END || o.id) AS doc_no,
                    o.outbound_date AS transaction_date,
                    CASE WHEN o.is_loan = 1 THEN 'loan' ELSE 'outbound' END AS type,
                    p.part_number, p.part_name, o.quantity, o.created_by,
                    o.created_at AS created_at, o.id AS rec_id
                FROM outbound_records o
                JOIN parts p ON o.part_id = p.id
                LEFT JOIN categories c ON p.category_id = c.id
                ${recentWhere}
            ) combined
            ORDER BY transaction_date DESC, created_at DESC, rec_id DESC
            LIMIT 10
        `);
        const recentTransactions = recentTransStmt.all(...recentParams, ...recentParams);
    
        // 獲取所有類型用於下拉選單
        const categoriesStmt = db.prepare('SELECT * FROM categories ORDER BY name');
        const categories = categoriesStmt.all();
        
        res.render('index', { 
            inventory, 
            categories,
            lowStockItems,
            recentTransactions,
            loanDetailsByPart,
            search: search || '',
            category_id: category_id || '',
            user: req.session.user,
            title: PAGE_TITLE 
        });
    });
};
