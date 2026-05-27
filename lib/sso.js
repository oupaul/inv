// M365 / Entra ID SSO（OpenID Connect 授權碼流程）封裝
// 使用 @azure/msal-node。僅在 config.SSO_ENABLED 時建立 client。
const config = require('./config');
const logger = require('./logger');

// 以 email 比對「啟用中」的使用者（不區分大小寫）。找不到回 null。
// 政策：不自動建立帳號，必須事先由管理員建立且 email 相符。
function resolveUserByEmail(db, email) {
    if (!email) return null;
    return db.prepare(
        'SELECT * FROM users WHERE lower(email) = lower(?) AND COALESCE(is_active, 1) = 1'
    ).get(String(email).trim()) || null;
}

// 從 id token claims / account 取出 email，依序嘗試常見欄位
function extractEmail(claims, account) {
    const c = claims || {};
    const candidates = [c.email, c.preferred_username, c.upn, account && account.username];
    for (const v of candidates) {
        if (v && String(v).includes('@')) return String(v).trim();
    }
    // 沒有 @ 的也回傳第一個非空（極少數情況），讓上層決定
    for (const v of candidates) {
        if (v) return String(v).trim();
    }
    return '';
}

const SCOPES = ['openid', 'profile', 'email'];

function createSso() {
    if (!config.SSO_ENABLED) {
        return { enabled: false };
    }
    let ConfidentialClientApplication;
    try {
        ({ ConfidentialClientApplication } = require('@azure/msal-node'));
    } catch (e) {
        logger.error('⚠️  SSO 已設定但找不到 @azure/msal-node，請執行 npm install。SSO 停用。', e.message);
        return { enabled: false };
    }

    const cca = new ConfidentialClientApplication({
        auth: {
            clientId: config.SSO_CLIENT_ID,
            authority: `https://login.microsoftonline.com/${config.SSO_TENANT_ID}`,
            clientSecret: config.SSO_CLIENT_SECRET,
        }
    });

    return {
        enabled: true,

        // 產生導向 Entra 的授權 URL；state 由呼叫端產生並存 session，回呼時比對
        getAuthUrl(state) {
            return cca.getAuthCodeUrl({
                scopes: SCOPES,
                redirectUri: config.SSO_REDIRECT_URI,
                state,
                responseMode: 'query',
                prompt: 'select_account',
            });
        },

        // 用授權碼換 token，回傳 { email, name, claims }
        async exchangeCode(code) {
            const result = await cca.acquireTokenByCode({
                code,
                scopes: SCOPES,
                redirectUri: config.SSO_REDIRECT_URI,
            });
            const claims = result.idTokenClaims || {};
            return {
                email: extractEmail(claims, result.account),
                name: (result.account && result.account.name) || claims.name || '',
                claims,
            };
        },
    };
}

module.exports = { createSso, resolveUserByEmail, extractEmail };
