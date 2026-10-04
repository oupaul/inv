// 庫存計算 SQL 片段與 prepared statement 快取
// 設計原則見原 server.js 內註解：
//   ownedStock = 帳上擁有量（含借出未歸還；扣一般出庫、加退回）
//   physicalStock = 實體庫存 = SUM(inbound) - SUM(outbound)
//   loanedQty = 借出中 = SUM(loan outbound) - SUM(loan return)

module.exports = function createSqlHelpers(db) {
    // 預備陳述快取：相同 SQL 字串只 prepare 一次
    const _stmtCache = new Map();
    function prep(sql) {
        let s = _stmtCache.get(sql);
        if (!s) {
            s = db.prepare(sql);
            _stmtCache.set(sql, s);
        }
        return s;
    }

    function ownedStockSql(partRef) {
        return `
            COALESCE((
                SELECT SUM(i.quantity) FROM inbound_records i
                LEFT JOIN outbound_records lo ON i.return_outbound_id = lo.id
                WHERE i.part_id = ${partRef}
                  AND NOT (COALESCE(i.is_return, 0) = 1 AND COALESCE(lo.is_loan, 0) = 1)
            ), 0) - COALESCE((
                SELECT SUM(o.quantity) FROM outbound_records o
                WHERE o.part_id = ${partRef}
                  AND COALESCE(o.is_loan, 0) = 0
            ), 0)
        `;
    }

    function physicalStockSql(partRef) {
        return `
            COALESCE((SELECT SUM(quantity) FROM inbound_records WHERE part_id = ${partRef}), 0) -
            COALESCE((SELECT SUM(quantity) FROM outbound_records  WHERE part_id = ${partRef}), 0)
        `;
    }

    function loanedQtySql(partRef) {
        return `
            COALESCE((
                SELECT SUM(o.quantity) - COALESCE((
                    SELECT SUM(i.quantity) FROM inbound_records i
                    WHERE i.return_outbound_id = o.id AND COALESCE(i.is_return, 0) = 1
                ), 0)
                FROM outbound_records o
                WHERE o.part_id = ${partRef} AND COALESCE(o.is_loan, 0) = 1
            ), 0)
        `;
    }

    // 借測未歸還對帳（基礎查詢）：對每筆借測出庫（is_loan=1，排除已作廢）計算已歸還／未歸還數量。
    // 回傳一段 SELECT 字串，供呼叫端包成 derived table 再視需要 JOIN parts/categories、加排序或額外欄位。
    // 固定輸出欄位：id, part_id, outbound_date, loan_due_date, quantity, created_by, note,
    //               notification_sent, created_at, returned_quantity, remaining_quantity
    //
    // 選項：
    //   partIdRef      - 限定單一料件（傳入 SQL 參數佔位符，如 '?'，或欄位參照）
    //   outboundIdRef  - 限定單一出庫記錄 id（同上）
    //   onlyOutstanding - 預設 true：只回傳 remaining_quantity > 0 的記錄（HAVING 過濾）；
    //                     設 false 可查到「已全部歸還」的記錄本身（例如借測轉出貨前需要分辨
    //                     「找不到記錄」與「已全部歸還」兩種不同錯誤訊息時使用）
    //
    // 注意：此函式新增了 (o.is_voided = 0 OR o.is_voided IS NULL) 過濾條件——這是修補既有行為：
    // 先前各呼叫點各自土炮同樣的 SQL 時，都沒有排除已作廢的借測出庫記錄，導致作廢後的借測仍會
    // 誤判為「未歸還」而出現在借出中列表 / 儀表板 / 通知。改用此共用函式後此 bug 一併修正。
    function outstandingLoansBaseSql({ partIdRef = null, outboundIdRef = null, onlyOutstanding = true } = {}) {
        const extra = [];
        if (partIdRef) extra.push(`o.part_id = ${partIdRef}`);
        if (outboundIdRef) extra.push(`o.id = ${outboundIdRef}`);
        const whereExtra = extra.length ? ' AND ' + extra.join(' AND ') : '';
        const having = onlyOutstanding ? 'HAVING remaining_quantity > 0' : '';
        return `
            SELECT
                o.id, o.part_id, o.outbound_date, o.loan_due_date, o.quantity,
                o.created_by, o.note, o.notification_sent, o.created_at,
                COALESCE(SUM(i.quantity), 0) as returned_quantity,
                o.quantity - COALESCE(SUM(i.quantity), 0) as remaining_quantity
            FROM outbound_records o
            LEFT JOIN inbound_records i ON i.return_outbound_id = o.id
            WHERE o.is_loan = 1 AND (o.is_voided = 0 OR o.is_voided IS NULL) ${whereExtra}
            GROUP BY o.id
            ${having}
        `;
    }

    // 檢查欄位是否存在（schema 遷移用）
    function columnExists(tableName, columnName) {
        try {
            const info = db.prepare(`PRAGMA table_info(${tableName})`).all();
            return info.some(col => col.name === columnName);
        } catch (e) {
            return false;
        }
    }

    return { prep, ownedStockSql, physicalStockSql, loanedQtySql, outstandingLoansBaseSql, columnExists };
};
