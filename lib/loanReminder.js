// 借測逾期通知：每日固定時間檢查已逾期／即將到期的借測記錄，彙整寄送 Email 通知
const logger = require('./logger');

const NOTIFY_HOUR = 9; // 每天 09:00–09:05 的視窗內檢查一次

function createLoanReminderChecker({ db, getSystemSetting, buildEmailHtml, sendNotificationEmail }) {
    let lastRunDate = null;

    function queryOutstandingLoans() {
        return db.prepare(`
            SELECT
                o.id, o.outbound_date as loan_date, o.loan_due_date,
                p.part_number, p.part_name, p.unit,
                o.quantity - COALESCE(SUM(i.quantity), 0) as remaining_quantity,
                CASE
                    WHEN date(o.loan_due_date) < date('now', '+8 hours') THEN 'overdue'
                    WHEN date(o.loan_due_date) = date('now', '+8 hours') THEN 'due_today'
                    WHEN date(o.loan_due_date) <= date('now', '+8 hours', '+3 days') THEN 'due_soon'
                    ELSE 'normal'
                END as due_status,
                CAST(julianday('now', '+8 hours') - julianday(o.loan_due_date) AS INTEGER) as overdue_days
            FROM outbound_records o
            JOIN parts p ON o.part_id = p.id
            LEFT JOIN inbound_records i ON i.return_outbound_id = o.id
            WHERE o.is_loan = 1
                AND o.loan_due_date IS NOT NULL
                AND (o.is_voided = 0 OR o.is_voided IS NULL)
                AND date(o.loan_due_date) <= date('now', '+8 hours', '+3 days')
            GROUP BY o.id
            HAVING remaining_quantity > 0
            ORDER BY
                CASE due_status WHEN 'overdue' THEN 0 WHEN 'due_today' THEN 1 ELSE 2 END,
                o.loan_due_date ASC
        `).all();
    }

    async function sendDigest(loans) {
        const overdue = loans.filter(l => l.due_status === 'overdue');
        const dueToday = loans.filter(l => l.due_status === 'due_today');
        const dueSoon = loans.filter(l => l.due_status === 'due_soon');

        const rows = [
            ['統計', `逾期 ${overdue.length} 筆・今日到期 ${dueToday.length} 筆・3天內到期 ${dueSoon.length} 筆`]
        ];
        overdue.forEach(l => rows.push([
            `⚠️ ${l.part_number} - ${l.part_name}`,
            `已逾期 ${l.overdue_days} 天（到期日 ${l.loan_due_date}），未還數量 ${l.remaining_quantity} ${l.unit}`
        ]));
        dueToday.forEach(l => rows.push([
            `🔶 ${l.part_number} - ${l.part_name}`,
            `今日到期，未還數量 ${l.remaining_quantity} ${l.unit}`
        ]));
        dueSoon.forEach(l => rows.push([
            `🔷 ${l.part_number} - ${l.part_name}`,
            `即將到期（${l.loan_due_date}），未還數量 ${l.remaining_quantity} ${l.unit}`
        ]));

        const html = buildEmailHtml('借測逾期提醒', rows, '系統排程', new Date().toLocaleString('zh-TW'));
        const subject = `【庫存系統】借測逾期提醒 - 逾期 ${overdue.length} 筆、今日到期 ${dueToday.length} 筆`;
        return sendNotificationEmail(subject, html);
    }

    async function check() {
        try {
            if (getSystemSetting('email_notify_loan_overdue', '1') !== '1') return;

            const now = new Date();
            if (now.getHours() !== NOTIFY_HOUR || now.getMinutes() >= 5) return;

            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
            if (lastRunDate === today) return;
            lastRunDate = today;

            const loans = queryOutstandingLoans();
            if (loans.length === 0) return;

            const result = await sendDigest(loans);
            if (result.success) {
                const overdueCount = loans.filter(l => l.due_status === 'overdue').length;
                logger.info(`📧 借測逾期提醒已發送（逾期 ${overdueCount} 筆，共 ${loans.length} 筆）`);
            }
        } catch (e) {
            logger.error('借測逾期排程檢查失敗:', e.message);
        }
    }

    return { check };
}

module.exports = { createLoanReminderChecker };
