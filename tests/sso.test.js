// lib/sso.js 純函式單元測試（不需 @azure/msal-node）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractEmail } = require('../lib/sso');

test('extractEmail 優先取 email claim', () => {
    assert.equal(extractEmail({ email: 'a@b.com', preferred_username: 'x@y.com' }, null), 'a@b.com');
});

test('extractEmail 退而取 preferred_username', () => {
    assert.equal(extractEmail({ preferred_username: 'user@corp.com' }, null), 'user@corp.com');
});

test('extractEmail 退而取 upn', () => {
    assert.equal(extractEmail({ upn: 'u@corp.com' }, null), 'u@corp.com');
});

test('extractEmail 退而取 account.username', () => {
    assert.equal(extractEmail({}, { username: 'acc@corp.com' }), 'acc@corp.com');
});

test('extractEmail 優先有 @ 的值', () => {
    // preferred_username 沒有 @（罕見），但 email 有 → 取 email
    assert.equal(extractEmail({ preferred_username: 'noat', email: 'real@corp.com' }, null), 'real@corp.com');
});

test('extractEmail 全空回空字串', () => {
    assert.equal(extractEmail({}, null), '');
    assert.equal(extractEmail(null, null), '');
});
