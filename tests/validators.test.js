// 驗證器單元測試（使用 Node 內建的 node:test，無需額外相依）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rules, check } = require('../lib/validators');

test('username 拒絕空字串', () => {
    assert.equal(typeof rules.username(''), 'string');
});

test('username 拒絕非法字元', () => {
    assert.equal(typeof rules.username('user space!'), 'string');
});

test('username 接受合法值', () => {
    assert.equal(rules.username('admin01'), null);
    assert.equal(rules.username('paul.ou@example'), null);
});

test('password 拒絕過短', () => {
    assert.equal(typeof rules.password('abc'), 'string');
});

test('password 接受 6 字以上', () => {
    assert.equal(rules.password('abcdef'), null);
});

test('email 可選且空字串視為通過', () => {
    assert.equal(rules.email(''), null);
});

test('email 拒絕無效格式', () => {
    assert.equal(typeof rules.email('not-an-email'), 'string');
});

test('email 接受合法格式', () => {
    assert.equal(rules.email('a@b.co'), null);
});

test('partNumber 拒絕空', () => {
    assert.equal(typeof rules.partNumber(''), 'string');
});

test('partNumber 接受常見字元', () => {
    assert.equal(rules.partNumber('PN-001/A'), null);
});

test('nonNegativeInt 接受 0 與正整數', () => {
    assert.equal(rules.nonNegativeInt('0'), null);
    assert.equal(rules.nonNegativeInt(5), null);
});

test('nonNegativeInt 拒絕負數與非數', () => {
    assert.equal(typeof rules.nonNegativeInt(-1), 'string');
    assert.equal(typeof rules.nonNegativeInt('abc'), 'string');
});

test('barcode 接受空（選填）', () => {
    assert.equal(rules.barcode(''), null);
    assert.equal(rules.barcode('  '), null);
});

test('barcode 拒絕非法字元', () => {
    assert.equal(typeof rules.barcode('12 34'), 'string');
});

test('check 收集多個錯誤', () => {
    const r = check([
        ['a', rules.username('')],
        ['b', rules.password('xx')]
    ]);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 2);
});

test('check 全部通過', () => {
    const r = check([
        ['a', rules.username('admin')],
        ['b', rules.password('abcdef')]
    ]);
    assert.equal(r.ok, true);
});
