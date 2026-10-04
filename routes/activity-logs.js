// 操作記錄查詢 + 匯出 + 清理 API（僅管理員）
const logger = require('../lib/logger');
const ExcelJS = require('exceljs');

// 從 query string 建立 WHERE 條件，供查詢頁與匯出共用
function buildActivityLogQuery(query) {
    const { username, action_type, date_from, date_to } = query || {};
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
    return { whereClause, params };
}

module.exports = function mountActivityLogRoutes(ctx) {
    const { app, db, config, flash, logActivity, requireAdmin, cleanupActivityLogs } = ctx;
    const PAGE_TITLE = config.PAGE_TITLE;

    app.get('/activity-logs', requireAdmin, (req, res) => {
        try {
            const { username, action_type, date_from, date_to } = req.query;
            const { whereClause, params } = buildActivityLogQuery(req.query);

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

    // 匯出操作記錄 Excel（管理員；套用與查詢頁相同的篩選條件）
    app.get('/export/activity-logs', requireAdmin, async (req, res) => {
        try {
            const { whereClause, params } = buildActivityLogQuery(req.query);

            const logs = db.prepare(`
                SELECT
                    username as '使用者',
                    action_type as '動作類型',
                    action_detail as '動作內容',
                    target_type as '對象類型',
                    target_id as '對象ID',
                    ip_address as 'IP',
                    datetime(created_at, '+8 hours') as '時間'
                FROM activity_logs
                ${whereClause}
                ORDER BY created_at DESC
                LIMIT 20000
            `).all(...params);

            logActivity(req, 'export', '匯出操作記錄', 'activity_logs', null);

            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('操作記錄');
            worksheet.columns = [
                { header: '使用者', key: '使用者', width: 15 },
                { header: '動作類型', key: '動作類型', width: 12 },
                { header: '動作內容', key: '動作內容', width: 50 },
                { header: '對象類型', key: '對象類型', width: 15 },
                { header: '對象ID', key: '對象ID', width: 10 },
                { header: 'IP', key: 'IP', width: 15 },
                { header: '時間', key: '時間', width: 20 }
            ];
            logs.forEach(row => worksheet.addRow(row));

            worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
            worksheet.getRow(1).fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FF667EEA' }
            };

            const buffer = await workbook.xlsx.writeBuffer();
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('操作記錄.xlsx')}`);
            res.send(buffer);
        } catch (error) {
            logger.error('匯出操作記錄失敗:', error);
            flash(req, 'error', `匯出失敗：${error.message}`);
            res.redirect('/activity-logs');
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
