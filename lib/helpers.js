// 共用 helper：flash、operations log、系統設定 CRUD
const logger = require('./logger');

module.exports = function createHelpers({ db, prep }) {
    function flash(req, category, message) {
        if (!req.session.messages) req.session.messages = [];
        req.session.messages.push({ category, message });
    }

    function logActivity(req, actionType, actionDetail, targetType = null, targetId = null) {
        try {
            const userId = req.session && req.session.user ? req.session.user.id : null;
            const username = req.session && req.session.user ? req.session.user.username : 'anonymous';
            const ipAddress = req.ip || (req.connection && req.connection.remoteAddress) || '';
            const userAgent = req.get ? req.get('user-agent') || '' : '';
            prep(`
                INSERT INTO activity_logs (user_id, username, action_type, action_detail, target_type, target_id, ip_address, user_agent)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(userId, username, actionType, actionDetail, targetType, targetId, ipAddress, userAgent);
        } catch (error) {
            logger.error('記錄操作日誌失敗:', error);
        }
    }

    function getSystemSetting(key, defaultValue = null) {
        try {
            const row = prep('SELECT setting_value FROM system_settings WHERE setting_key = ?').get(key);
            return row ? row.setting_value : defaultValue;
        } catch (error) {
            logger.error('讀取系統設定失敗:', error);
            return defaultValue;
        }
    }

    function upsertSystemSetting(key, value, description) {
        const stmt = db.prepare(`
            INSERT INTO system_settings (setting_key, setting_value, description, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(setting_key) DO UPDATE SET
                setting_value = excluded.setting_value,
                updated_at = CURRENT_TIMESTAMP
        `);
        stmt.run(key, value, description);
    }

    function hasPermission(user, mod, action) {
        if (user && user.role === 'admin') return true;
        if (user && user.permissions && user.permissions[mod]) {
            return user.permissions[mod].includes(action);
        }
        return false;
    }

    return { flash, logActivity, getSystemSetting, upsertSystemSetting, hasPermission };
};
