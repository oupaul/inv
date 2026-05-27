// 操作記錄查詢 + 清理 API（僅管理員）
const logger = require('../lib/logger');

module.exports = function mountActivityLogRoutes(ctx) {
    const { app, db, config, flash, logActivity, requireAdmin, cleanupActivityLogs } = ctx;
    const PAGE_TITLE = config.PAGE_TITLE;

    app.get('/activity-logs', requireAdmin, (req, res) => {
        try {
            const { username, action_type, date_from, date_to } = req.query;
            const whereConditions = [];
            const params = [];

            if (username && username.trim()) {
                whereConditions.push('username LIKE ?');
                params.push(`%${username.trim()}%`);
            }
            if (action_type && action_type.trim()) {
                whereConditions.push('action_type = ?');
                params.push(action_type.trim());
            }
            if (date_from && date_from.trim()) {
                whereConditions.push("DATE(datetime(created_at, '+8 hours')) >= ?");
                params.push(date_from.trim());
            }
            if (date_to && date_to.trim()) {
                whereConditions.push("DATE(datetime(created_at, '+8 hours')) <= ?");
                params.push(date_to.trim());
            }
            const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

            const logs = db.prepare(`
                SELECT id, user_id, username, action_type, action_detail, target_type, target_id,
                       ip_address, user_agent,
                       datetime(created_at, '+8 hours') as created_at
                FROM activity_logs
                ${whereClause}
                ORDER BY created_at DESC
                LIMIT 500
            `).all(...params);

            logActivity(req, 'view', '查看操作記錄', 'activity_logs', null);
            res.render('activity_logs', {
                title: PAGE_TITLE,
                logs,
                username: username || '',
                action_type: action_type || '',
                date_from: date_from || '',
                date_to: date_to || ''
            });
        } catch (error) {
            logger.error('載入操作記錄錯誤:', error);
            flash(req, 'error', '載入操作記錄失敗');
            res.redirect('/');
        }
    });

    // 手動觸發清理（管理員）
    app.post('/api/admin/cleanup-activity-logs', requireAdmin, (req, res) => {
        const days = req.body && req.body.days != null ? parseInt(req.body.days) : undefined;
        if (days !== undefined && (!Number.isInteger(days) || days < 0)) {
            return res.status(400).json({ success: false, error: 'days 必須為 >= 0 的整數' });
        }
        const result = cleanupActivityLogs(days !== undefined ? { days } : {});
        logActivity(req, 'cleanup', `手動清理 activity_logs：${JSON.stringify(result)}`, 'activity_logs', null);
        res.json({ success: true, result });
    });
};
