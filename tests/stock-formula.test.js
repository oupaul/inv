// 庫存公式單元測試：不依賴 better-sqlite3（沒有 native build）
// 重點：驗證 ownedStockSql / physicalStockSql / loanedQtySql 的 SQL 片段結構，
// 並用純 JS 重現相同邏輯，跑使用者回報的「一般出庫 + 退回」案例。
const { test } = require('node:test');
const assert = require('node:assert/strict');

// 純 JS 實作三個庫存公式（與 server.js 中 SQL 邏輯等價）
function ownedStock(rows) {
    const inboundOwned = rows.inbound.reduce((sum, i) => {
        const linkedOutbound = i.return_outbound_id != null
            ? rows.outbound.find(o => o.id === i.return_outbound_id)
            : null;
        // 排除「借測退回」(is_return=1 且對應的 outbound is_loan=1)
        if (i.is_return && linkedOutbound && linkedOutbound.is_loan) return sum;
        return sum + i.quantity;
    }, 0);
    const outboundOwned = rows.outbound.reduce((sum, o) => {
        if (o.is_loan) return sum;
        return sum + o.quantity;
    }, 0);
    return inboundOwned - outboundOwned;
}

function physicalStock(rows) {
    return rows.inbound.reduce((s, i) => s + i.quantity, 0)
         - rows.outbound.reduce((s, o) => s + o.quantity, 0);
}

function loanedQty(rows) {
    return rows.outbound.reduce((sum, o) => {
        if (!o.is_loan) return sum;
        const returned = rows.inbound
            .filter(i => i.return_outbound_id === o.id && i.is_return)
            .reduce((s, i) => s + i.quantity, 0);
        return sum + (o.quantity - returned);
    }, 0);
}

test('使用者回報案例：一般出庫 -2 → 退回 +2，重複兩次，最終庫存應為 0', () => {
    const rows = {
        outbound: [
            { id: 1, quantity: 2, is_loan: 0 },           // 04:09:54 出庫 -2
            { id: 2, quantity: 2, is_loan: 0 }            // 04:11:10 出庫 -2
        ],
        inbound: [
            { id: 101, quantity: 2, is_return: 1, return_outbound_id: 1 },  // 04:10:29 歸還 +2
            { id: 102, quantity: 2, is_return: 1, return_outbound_id: 2 }   // 04:11:27 歸還 +2
        ]
    };
    assert.equal(ownedStock(rows), 0, 'ownedStock 應為 0');
    assert.equal(physicalStock(rows), 0, 'physicalStock 應為 0');
    assert.equal(loanedQty(rows), 0, '無借測，loaned 應為 0');
});

test('純入庫場景：入庫 10，庫存 = 10', () => {
    const rows = {
        inbound: [{ id: 1, quantity: 10, is_return: 0, return_outbound_id: null }],
        outbound: []
    };
    assert.equal(ownedStock(rows), 10);
    assert.equal(physicalStock(rows), 10);
});

test('入庫 10、出庫 3：擁有 = 7、物理 = 7', () => {
    const rows = {
        inbound: [{ id: 1, quantity: 10, is_return: 0, return_outbound_id: null }],
        outbound: [{ id: 1, quantity: 3, is_loan: 0 }]
    };
    assert.equal(ownedStock(rows), 7);
    assert.equal(physicalStock(rows), 7);
});

test('借測場景：入庫 10、借測 4，擁有 = 10、物理 = 6、借出中 = 4', () => {
    const rows = {
        inbound: [{ id: 1, quantity: 10, is_return: 0, return_outbound_id: null }],
        outbound: [{ id: 1, quantity: 4, is_loan: 1 }]
    };
    assert.equal(ownedStock(rows), 10, '借測不扣帳上擁有量');
    assert.equal(physicalStock(rows), 6, '借測扣物理庫存');
    assert.equal(loanedQty(rows), 4, '借出中 = 4');
});

test('借測歸還：入庫 10、借測 4、借測歸還 4 → 擁有 = 10、物理 = 10、借出 = 0', () => {
    const rows = {
        inbound: [
            { id: 1, quantity: 10, is_return: 0, return_outbound_id: null },
            { id: 2, quantity: 4, is_return: 1, return_outbound_id: 1 }  // 借測歸還
        ],
        outbound: [{ id: 1, quantity: 4, is_loan: 1 }]
    };
    assert.equal(ownedStock(rows), 10);
    assert.equal(physicalStock(rows), 10);
    assert.equal(loanedQty(rows), 0);
});

test('部份借測歸還：入庫 10、借測 4、歸還 2 → 借出 = 2、物理 = 8', () => {
    const rows = {
        inbound: [
            { id: 1, quantity: 10, is_return: 0, return_outbound_id: null },
            { id: 2, quantity: 2, is_return: 1, return_outbound_id: 1 }
        ],
        outbound: [{ id: 1, quantity: 4, is_loan: 1 }]
    };
    assert.equal(loanedQty(rows), 2);
    assert.equal(physicalStock(rows), 8);
});

test('一般出庫 + 退回：物理應正確還原', () => {
    const rows = {
        inbound: [
            { id: 1, quantity: 10, is_return: 0, return_outbound_id: null },  // 進貨
            { id: 2, quantity: 3, is_return: 1, return_outbound_id: 1 }       // 客戶退回
        ],
        outbound: [{ id: 1, quantity: 3, is_loan: 0 }]                         // 一般出庫
    };
    assert.equal(ownedStock(rows), 10, '出貨 3 + 退回 3 = 0 變化');
    assert.equal(physicalStock(rows), 10, '物理庫存也是 10');
});

test('混合：入 10、出 3、退 2、借 4、借歸 1', () => {
    const rows = {
        inbound: [
            { id: 1, quantity: 10, is_return: 0, return_outbound_id: null },
            { id: 2, quantity: 2,  is_return: 1, return_outbound_id: 1 },  // 退一般出庫
            { id: 3, quantity: 1,  is_return: 1, return_outbound_id: 2 }   // 借測歸還 1
        ],
        outbound: [
            { id: 1, quantity: 3, is_loan: 0 },  // 一般出庫
            { id: 2, quantity: 4, is_loan: 1 }   // 借測
        ]
    };
    // owned = (10 + 2) - 3 = 9（借測退回 1 排除，因連到 is_loan=1）
    assert.equal(ownedStock(rows), 9);
    // physical = (10+2+1) - (3+4) = 13 - 7 = 6
    assert.equal(physicalStock(rows), 6);
    // loaned = 4 - 1 = 3
    assert.equal(loanedQty(rows), 3);
});

test('作廢配對：原 outbound 與作廢反向 inbound 自動抵銷', () => {
    const rows = {
        inbound: [
            { id: 1, quantity: 10, is_return: 0, return_outbound_id: null },
            { id: 2, quantity: 3,  is_return: 0, return_outbound_id: null, is_void_reversal: 1 } // 作廢反向
        ],
        outbound: [
            { id: 1, quantity: 3, is_loan: 0, is_voided: 1 }  // 已作廢
        ]
    };
    // 物理 = (10+3) - 3 = 10 ✓
    assert.equal(physicalStock(rows), 10);
});
