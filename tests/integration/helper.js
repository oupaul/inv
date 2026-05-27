// 整合測試輔助工具
const request = require('supertest');

// 登入並回傳帶 cookie 的 agent
async function loginAsAdmin(app) {
    const agent = request.agent(app);
    // 預設管理員：admin / admin123（force_password_change=1）
    const res = await agent
        .post('/login')
        .type('form')
        .set('Origin', 'http://localhost')
        .send({ username: 'admin', password: 'admin123' });
    // 登入成功後會 redirect（302）
    if (res.status !== 302) {
        throw new Error(`登入失敗：status=${res.status}, body=${res.text.slice(0, 200)}`);
    }
    return agent;
}

// 修改強制密碼變更（首次登入後需要）
async function completeForcePasswordChange(agent, newPassword) {
    const res = await agent
        .post('/change-password')
        .type('form')
        .set('Origin', 'http://localhost')
        .send({
            current_password: 'admin123',
            new_password: newPassword,
            confirm_password: newPassword
        });
    return res;
}

// 帶 Origin header 的 POST helper（通過 Origin 檢查）
function postForm(agentOrApp, path, body) {
    return agentOrApp.post(path)
        .type('form')
        .set('Origin', 'http://localhost')
        .send(body);
}

module.exports = { loginAsAdmin, completeForcePasswordChange, postForm };
