// 輸入驗證輔助函式：避免引入 zod/joi 體積，自行實作核心檢查
// 用法：呼叫 validate(rules, input)，回傳 { ok, errors, value }

function isNonEmptyString(v) {
    return typeof v === 'string' && v.trim().length > 0;
}

function asString(v) {
    return v == null ? '' : String(v);
}

function asTrimmed(v, maxLen) {
    const s = asString(v).trim();
    return maxLen ? s.slice(0, maxLen) : s;
}

// ---- 共用基礎驗證 ----
const rules = {
    username(v) {
        const s = asTrimmed(v, 64);
        if (!s) return '帳號不可為空';
        if (s.length < 2) return '帳號長度至少 2 字元';
        if (s.length > 64) return '帳號長度不可超過 64 字元';
        if (!/^[\w.\-@]+$/u.test(s)) return '帳號僅允許英數字、底線、點、減號、@';
        return null;
    },
    password(v) {
        if (typeof v !== 'string') return '密碼格式錯誤';
        if (v.length < 6) return '密碼長度至少 6 字元';
        if (v.length > 200) return '密碼過長';
        return null;
    },
    email(v, { optional = true } = {}) {
        const s = asString(v).trim();
        if (!s) return optional ? null : 'Email 不可為空';
        if (s.length > 200) return 'Email 過長';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'Email 格式不正確';
        return null;
    },
    partNumber(v) {
        const s = asString(v).trim();
        if (!s) return '料號不可為空';
        if (s.length > 100) return '料號長度不可超過 100 字元';
        if (!/^[\w.\-/\s]+$/u.test(s)) return '料號僅允許英數字、底線、點、減號、斜線、空白';
        return null;
    },
    partName(v) {
        const s = asString(v).trim();
        if (!s) return '料件名稱不可為空';
        if (s.length > 200) return '料件名稱長度不可超過 200 字元';
        return null;
    },
    positiveInt(v, { min = 1, max = 1e9, optional = false } = {}) {
        if ((v === '' || v == null) && optional) return null;
        const n = Number(v);
        if (!Number.isInteger(n)) return '必須為整數';
        if (n < min) return `必須 >= ${min}`;
        if (n > max) return `必須 <= ${max}`;
        return null;
    },
    nonNegativeInt(v, opts = {}) {
        return rules.positiveInt(v, { min: 0, ...opts });
    },
    nonNegativeNumber(v, { max = 1e9, optional = true } = {}) {
        if ((v === '' || v == null) && optional) return null;
        const n = Number(v);
        if (!Number.isFinite(n)) return '必須為數字';
        if (n < 0) return '必須 >= 0';
        if (n > max) return `必須 <= ${max}`;
        return null;
    },
    dateString(v, { optional = false } = {}) {
        const s = asString(v).trim();
        if (!s) return optional ? null : '日期不可為空';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '日期格式必須為 YYYY-MM-DD';
        const d = new Date(s);
        if (isNaN(d.getTime())) return '日期無效';
        return null;
    },
    barcode(v) {
        const s = asString(v).trim();
        if (!s) return null; // 可為空
        if (s.length > 100) return '條碼長度不可超過 100 字元';
        if (!/^[\w\-]+$/.test(s)) return '條碼僅允許英數字、底線、減號';
        return null;
    },
    // 顯示名稱（類型、單位、角色等）
    displayName(v, { label = '名稱', max = 100 } = {}) {
        const s = asString(v).trim();
        if (!s) return `${label}不可為空`;
        if (s.length > max) return `${label}長度不可超過 ${max} 字元`;
        return null;
    },
    // 自由文字（備註、規格、描述）
    freeText(v, { label = '文字', max = 1000, optional = true } = {}) {
        if ((v === '' || v == null) && optional) return null;
        const s = asString(v);
        if (s.length > max) return `${label}長度不可超過 ${max} 字元`;
        return null;
    }
};

// 將檢查結果整理為陣列；任一失敗則 ok=false
function check(checks) {
    const errors = [];
    for (const [field, err] of checks) {
        if (err) errors.push({ field, message: err });
    }
    return { ok: errors.length === 0, errors };
}

module.exports = {
    rules,
    check,
    helpers: { isNonEmptyString, asString, asTrimmed }
};
