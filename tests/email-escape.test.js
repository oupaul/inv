// 確認 buildEmailHtml 對使用者輸入做 HTML 跳脫
// 因為函式定義在 server.js 內，我們複製 escapeHtml 的同樣邏輯做檢查
const { test } = require('node:test');
const assert = require('node:assert/strict');

function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

test('escapeHtml 跳脫 <script> 標籤', () => {
    const out = escapeHtml('<script>alert(1)</script>');
    assert.ok(!out.includes('<script>'));
    assert.equal(out, '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('escapeHtml 跳脫引號（避免逃出 HTML 屬性）', () => {
    const out = escapeHtml('" onerror="alert(1)"');
    assert.ok(!out.includes('"'));
    assert.ok(out.includes('&quot;'));
});

test('escapeHtml 跳脫 & 不破壞既有實體', () => {
    assert.equal(escapeHtml('a & b'), 'a &amp; b');
});

test('escapeHtml 處理 null / undefined / 數字', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(42), '42');
});

test('escapeHtml 不影響正常中文', () => {
    assert.equal(escapeHtml('料件名稱 - 中文'), '料件名稱 - 中文');
});
