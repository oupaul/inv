# Integration Tests

這些測試會啟動完整的 server.js（用 :memory: SQLite 隔離），透過 supertest 模擬 HTTP 請求。

## 為什麼分開放在 `tests/integration/`

- **單元測試**（`tests/*.test.js`）只測 lib/ 模組，沒有相依 → 任何 Node 環境都能跑
- **整合測試**（`tests/integration/*.test.js`）需要 `better-sqlite3` 與 `supertest` → 需要 native build 環境

## 執行

```bash
# 確保已 npm install（包含 supertest devDep）
npm run test:integration

# 或單獨跑某個檔案
node --test tests/integration/stock-flow.test.js
```

## 設計重點

| 檔案 | 用途 |
|---|---|
| `setup.js` | 在 require server.js 之前設定 env：DB_FILE=:memory:、SESSION_DB_FILE=:memory:、關掉 rate limit |
| `helper.js` | loginAsAdmin / postForm / completeForcePasswordChange |
| `public-routes.test.js` | /healthz、/login、404、security headers、auth guard |
| `auth.test.js` | 登入流程、Origin 檢查、session 維持與失效 |
| `stock-flow.test.js` | 入庫/出庫/退回/作廢/庫存不足 — 涵蓋使用者回報的具體 bug |

## 注意

- 每個 test 檔案會載入自己的 :memory: DB（彼此隔離）
- 同一個檔案內的 test 共享一個 DB（順序執行）
- 不會碰到正式的 inventory.db / sessions.db
