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

    // 檢查欄位是否存在（schema 遷移用）
    function columnExists(tableName, columnName) {
        try {
            const info = db.prepare(`PRAGMA table_info(${tableName})`).all();
            return info.some(col => col.name === columnName);
        } catch (e) {
            return false;
        }
    }

    return { prep, ownedStockSql, physicalStockSql, loanedQtySql, columnExists };
};
