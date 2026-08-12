// Email 設定 + 測試發送
module.exports = function mountSettingsRoutes(ctx) {
    const { app, config, flash, logActivity, getSystemSetting, upsertSystemSetting,
            buildEmailHtml, sendNotificationEmail, requireAdmin } = ctx;
    const PAGE_TITLE = config.PAGE_TITLE;

    app.get('/settings/email', requireAdmin, (req, res) => {
        const settings = {
            smtp_host:       getSystemSetting('email_smtp_host', ''),
            smtp_port:       getSystemSetting('email_smtp_port', '587'),
            smtp_secure:     getSystemSetting('email_smtp_secure', '0'),
            smtp_user:       getSystemSetting('email_smtp_user', ''),
            smtp_password:   getSystemSetting('email_smtp_password', ''),
            from_address:    getSystemSetting('email_from_address', ''),
            from_name:       getSystemSetting('email_from_name', '庫存管理系統'),
            recipients:      getSystemSetting('email_notify_recipients', ''),
            notify_parts:    getSystemSetting('email_notify_parts', '1'),
            notify_inbound:  getSystemSetting('email_notify_inbound', '1'),
            notify_outbound: getSystemSetting('email_notify_outbound', '1'),
            notify_loan_overdue: getSystemSetting('email_notify_loan_overdue', '1'),
        };
        res.render('settings_email', { title: PAGE_TITLE, settings });
    });

    app.post('/settings/email', requireAdmin, (req, res) => {
        const {
            smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password,
            from_address, from_name, recipients,
            notify_parts, notify_inbound, notify_outbound, notify_loan_overdue
        } = req.body;
        try {
            upsertSystemSetting('email_smtp_host',         smtp_host || '',       'SMTP 伺服器位址');
            upsertSystemSetting('email_smtp_port',         smtp_port || '587',    'SMTP 連接埠');
            upsertSystemSetting('email_smtp_secure',       smtp_secure === 'on' ? '1' : '0', 'SMTP 使用 SSL/TLS');
            upsertSystemSetting('email_smtp_user',         smtp_user || '',       'SMTP 登入帳號');
            if (smtp_password && smtp_password.trim() !== '') {
                upsertSystemSetting('email_smtp_password', smtp_password.trim(),  'SMTP 登入密碼');
            }
            upsertSystemSetting('email_from_address',      from_address || '',    '寄件人 Email 地址');
            upsertSystemSetting('email_from_name',         from_name || '庫存管理系統', '寄件人顯示名稱');
            upsertSystemSetting('email_notify_recipients', recipients || '',       '通知收件人');
            upsertSystemSetting('email_notify_parts',      notify_parts === 'on' ? '1' : '0',    '料件異動通知');
            upsertSystemSetting('email_notify_inbound',    notify_inbound === 'on' ? '1' : '0',  '入庫通知');
            upsertSystemSetting('email_notify_outbound',   notify_outbound === 'on' ? '1' : '0', '出庫通知');
            upsertSystemSetting('email_notify_loan_overdue', notify_loan_overdue === 'on' ? '1' : '0', '借測逾期提醒（每天 09:00 檢查）');
            logActivity(req, 'update', '更新 Email 通知設定', 'system', null);
            flash(req, 'success', 'Email 通知設定已儲存！');
        } catch (error) {
            flash(req, 'error', `儲存失敗：${error.message}`);
        }
        res.redirect('/settings/email');
    });

    app.post('/api/settings/email/test', requireAdmin, async (req, res) => {
        try {
            const testHtml = buildEmailHtml('Email 測試通知', [
                ['狀態', '✅ 測試成功'],
                ['說明', '如果您收到此郵件，代表 Email 通知功能已正確設定。'],
            ], req.session.user.full_name || req.session.user.username, new Date().toLocaleString('zh-TW'));

            const result = await sendNotificationEmail('【庫存系統】Email 測試通知', testHtml);
            if (result.success) res.json({ success: true, message: '測試郵件已發送，請檢查收件匣' });
            else res.json({ success: false, error: result.error || result.reason || '發送失敗' });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });
};
