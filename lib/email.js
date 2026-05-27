// Email 通知與 HTML 跳脫
const nodemailer = require('nodemailer');
const logger = require('./logger');

function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function buildEmailHtml(title, rows, operatorName, operatorTime) {
    const rowsHtml = rows.map(([label, value]) =>
        `<tr><td style="padding:8px 12px;font-weight:600;color:#555;background:#f8f9fa;white-space:nowrap;">${escapeHtml(label)}</td><td style="padding:8px 12px;color:#222;">${escapeHtml(value)}</td></tr>`
    ).join('');
    return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#667eea,#764ba2);padding:20px 24px;">
        <h2 style="margin:0;color:#fff;font-size:18px;">📦 庫存管理系統通知</h2>
        <p style="margin:4px 0 0;color:rgba(255,255,255,.8);font-size:13px;">${escapeHtml(title)}</p>
      </div>
      <div style="padding:20px 24px;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          ${rowsHtml}
        </table>
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid #eee;font-size:12px;color:#999;">
          操作人員：${escapeHtml(operatorName || '系統')} &nbsp;|&nbsp; 時間：${escapeHtml(operatorTime || new Date().toLocaleString('zh-TW'))}
        </div>
      </div>
    </div>`;
}

// 工廠：傳入讀取系統設定的函式，回傳 sendNotificationEmail
function createMailer({ getSystemSetting }) {
    return async function sendNotificationEmail(subject, htmlContent) {
        try {
            const host     = getSystemSetting('email_smtp_host', '');
            const port     = parseInt(getSystemSetting('email_smtp_port', '587'));
            const secure   = getSystemSetting('email_smtp_secure', '0') === '1';
            const user     = getSystemSetting('email_smtp_user', '');
            const pass     = getSystemSetting('email_smtp_password', '');
            const fromAddr = getSystemSetting('email_from_address', '');
            const fromName = getSystemSetting('email_from_name', '庫存管理系統');
            const recipients = getSystemSetting('email_notify_recipients', '');

            if (!host || !user || !pass || !fromAddr || !recipients) {
                logger.info('📧 Email 通知未設定，略過發送');
                return { success: false, reason: '未設定' };
            }

            const transporter = nodemailer.createTransport({
                host, port, secure,
                auth: { user, pass },
                tls: { rejectUnauthorized: false }
            });

            const info = await transporter.sendMail({
                from: `"${fromName}" <${fromAddr}>`,
                to: recipients,
                subject,
                html: htmlContent
            });

            logger.info(`📧 Email 已發送：${info.messageId}`);
            return { success: true, messageId: info.messageId };
        } catch (error) {
            logger.error('📧 Email 發送失敗:', error.message);
            return { success: false, error: error.message };
        }
    };
}

module.exports = { escapeHtml, buildEmailHtml, createMailer };
