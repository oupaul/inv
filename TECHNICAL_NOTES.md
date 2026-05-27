# 技術文件 - 庫存管理系統

## 更新歷程

---

### 2026-05-27 — 安全強化、模組化重構、台灣時區、M365 SSO、測試與 CI

這是一次大型的安全性、可維護性與功能強化。**所有變更均為相容更新，不需資料庫遷移。**

#### 1. 安全性強化
- **Session 機密**：`SESSION_SECRET` 未設定時，生產環境直接 fail-fast（不再用寫死的後備值）
- **CSRF 防護**：Cookie `SameSite` + 所有非 GET 請求的 Origin/Referer 來源檢查（`lib/security.js`）
- **登入頻率限制**：同 IP+帳號 15 分鐘內超過上限回 429（防暴力破解）
- **安全 HTTP 標頭**：`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、HSTS（HTTPS 時）
- **全域認證守門**：白名單（`/login`、`/logout`、`/healthz`、`/auth/*`、`/public/*`）外的所有路由一律要求登入
- **上傳檔名**：改用隨機 UUID 命名，避免路徑穿越
- **輸入驗證**：`lib/validators.js` 對登入、料件、出入庫、發票、使用者等寫入端點做格式/長度/型別檢查
- **Email XSS**：通知信 HTML 內所有使用者輸入經 `escapeHtml()` 跳脫
- **相依套件**：升級 `multer` 2.x、`nodemailer` 8.x，session store 改用 `better-sqlite3-session-store`，`npm audit` **0 漏洞**

#### 2. 架構模組化（server.js 5948 → 1248 行）
- 共用邏輯抽到 `lib/`：`config`、`logger`、`sql`、`helpers`、`email`、`uploads`、`auth`、`security`、`validators`、`sso`
- 路由依領域抽到 `routes/`：`auth`、`sso`、`dashboard`、`parts`、`movements`、`inventory-check`、`invoices`、`reports`、`users`、`roles`、`settings`、`activity-logs`、`backup`、`categories`、`units`、`system`
- `server.js` 僅保留：DB 初始化、middleware 組裝、認證守門、排程、路由掛載、優雅關閉、`/healthz`

#### 3. 庫存計算 bug 修正（重要）
- 修正「一般出庫被退回後，庫存沒有加回」的計算錯誤
- 統一庫存公式（`lib/sql.js`）：
  - **物理庫存** = `SUM(inbound) − SUM(outbound)`（依靠 void+reversal 雙邊登錄自動抵銷）
  - **擁有量**（儀表板總庫存，含借出）/ **借出中** 各有對應 SQL helper
- 之前若曾因此 bug 手動補過庫存，升級後數字可能偏多，建議上線後做一次盤點對帳

#### 4. 全系統改用台灣時間（UTC+8）
- `process.env.TZ = 'Asia/Taipei'`（`lib/config.js` 最上方設定）→ 所有 JS `new Date()`/`toLocaleString()` 用台北時間
- DB 仍存 UTC（標準做法），**顯示時**以 `datetime(col, '+8 hours')` 轉 CST（出入庫記錄、盤點、料件/使用者列表等）
- 到期判斷（借測、發票逾期）改用 `date('now', '+8 hours')` 對齊台灣日曆
- 純顯示層調整，舊資料自動正確顯示，無重複加時風險

#### 5. M365 / Entra ID SSO 登入（OpenID Connect）
- 使用 `@azure/msal-node` 授權碼流程（`lib/sso.js`、`routes/sso.js`）
- 與帳密登入**並存**；登入頁顯示「使用 Microsoft 365 登入」按鈕（僅在設定齊全時）
- **比對政策**：以 M365 信箱比對 `users.email`（不分大小寫、`is_active=1`），**須事先由管理員建立帳號**，找不到即拒絕，不自動建帳號
- 因 SSO 回呼為跨站 top-level 導向，session cookie `SameSite` 預設改為 `lax`（CSRF 仍由 Origin 檢查把關）
- 設定方式見下方「M365 SSO 設定」章節

#### 6. 營運強化
- **Session 持久化**：寫入 `sessions.db`，重啟服務不會把使用者登出（`force_logout_minutes` 仍控制最長登入時間）
- **公開健康檢查**：`GET /healthz`（不需登入，供負載平衡/監控）
- **優雅關閉**：SIGINT/SIGTERM 時清理計時器、關閉 DB
- **備份保留策略**：`backup.sh` 與自動備份排程清理舊備份（預設保留 30 天 / 至少 7 份）
- **operation log 自動清理**：`activity_logs` 預設保留 90 天，每日 03:00 自動清理（管理員可手動觸發 `POST /api/admin/cleanup-activity-logs`）
- **DB 索引**：對庫存計算、發票、操作紀錄等高頻查詢欄位建立索引

#### 7. 儀表板「近期出入庫記錄」改善
- 新增**單據號碼**欄（記錄 ID 加類型前綴：`IN-`/`RT-`/`OUT-`/`LN-`）
- 連動上方類別/搜尋篩選（篩鋼品只看鋼品記錄）
- 修正排序：同日多筆改以實際登錄時間 `created_at` 為次序

#### 8. 測試與 CI
- **單元測試**（`tests/*.test.js`）：config、validators、security、stock-formula、email-escape、sso — 47 項
- **整合測試**（`tests/integration/*.test.js`）：auth、public-routes、stock-flow、invoices、inventory-check、reports、dashboard、timezone、sso
- **CI**（`.github/workflows/ci.yml`）：push/PR 自動跑 `npm run test:all` + `npm audit`（Node 18/20）
  - 指令：`npm test`（單元）、`npm run test:integration`、`npm run test:all`

> 註：整合測試需 `better-sqlite3` 原生編譯環境（Windows 無 Visual Studio 時跑不了，Linux/CI 可）。

---

### 2026-05-21 — 料件圖片上傳、QR Code 產生、發票編輯、庫存縮圖

#### 新增功能

**1. 料件圖片上傳**
- 每個料件可上傳一張主圖（`parts.image_path` 欄位）
- 圖片存放路徑：`public/uploads/parts/<partId>_<timestamp>.<ext>`
- 支援 JPEG / PNG / GIF / WebP，檔案大小上限 15 MB
- 更換圖片時自動刪除舊檔；刪除圖片時同步清除 DB 欄位
- 操作入口：
  - 料件管理清單 → 點開料件詳情 Modal → 上傳/更換/刪除
  - 編輯料件頁（`/parts/edit/:id`）→ 圖片上傳區塊，含即時預覽
- 手機相機拍照後直接上傳（NGINX `client_max_body_size` 需設為 `20M` 以上）

**2. 料件 QR Code（伺服器端產生）**
- 使用 `qrcode` npm 套件在伺服器端產生 PNG data URI（`GET /api/qr?text=...`）
- QR Code 內容：`料號|系統連結`（掃碼可直接開啟料件查詢頁面）
- 操作入口：料件管理清單 → 每列「🔳 QR」按鈕 → 彈出 Modal 顯示 QR Code
- Modal 功能：⬇️ 下載 PNG、🖨️ 列印標籤（開新視窗自動列印）
- 採伺服器端產生，完全不依賴前端 CDN 或 canvas，相容性最佳

**3. 發票編輯**
- 已儲存的發票可再次編輯（`GET /invoices/:id/edit`、`POST /invoices/:id/edit`）
- 編輯時以 DB transaction 保證原子性：更新表頭 → 刪除舊明細 → 新增新明細
- 發票詳情頁（`/invoices/:id`）加入「✏️ 編輯發票」按鈕

**4. 庫存查詢頁料件縮圖**
- 首頁（`/`）庫存列表加入縮圖欄
- 有圖片：顯示 36×36 圓角縮圖
- 無圖片：顯示灰色虛線佔位格（📷）
- SQL 查詢加入 `p.image_path` 欄位

---

### 2026-04-21 — 發票管理、退回出庫、作廢記錄、入庫類型篩選、儀表板強化

#### 新增功能

**1. 儀表板統計卡片點擊篩選**
- 首頁統計卡片（料件種類、總庫存量、借出中、可用庫存）點擊後可篩選庫存列表
- 「借出中」卡片點擊會顯示 Popover，列出每筆借測明細（料件、數量、到期日、借測對象）

**2. 發票管理模組（`invoices`、`invoice_items` 資料表）**
- 多筆出庫記錄可合併建立一張發票
- 發票狀態：`pending`（待確認）→ `issued`（已開立）→ `paid`（已付款）
- 付款到期日設定與逾期警示
- 出庫時系統自動提示建立/連結發票（綠色提示卡片，可選擇「立即建立」或「稍後處理」）
- 出入庫記錄頁可直接查看已連結發票或建立新發票
- 新增發票頁可從出庫記錄帶入料件明細（含數量、單位，可自行填入單價）

**3. 退回出庫料件**
- 入庫表單新增「退回出庫料件」區塊
- 選擇要退回的原始出庫記錄後送出，系統自動設定 `is_return=1`、`return_outbound_id=<原出庫ID>`
- 出入庫記錄中已退回的出庫不再顯示發票選項，改顯示「已全數歸還」狀態
- 修復：使用固定 hidden input（`final_is_return`、`final_return_outbound_id`）解決表單同名欄位衝突

**4. 入庫表單類型篩選**
- 料件選擇 select 上方新增類型篩選 dropdown
- 自動從料件的 `category_name` 提取不重複類型選項
- 篩選後 select 只顯示該類型料件，大幅縮短下拉長度

**5. 出入庫記錄作廢功能（管理員專屬）**
- 每筆有效記錄旁顯示「✕ 作廢」按鈕（僅管理員可見）
- 點擊後彈出確認 Modal，顯示記錄摘要，可填寫作廢原因
- 作廢流程（Transaction 保證原子性）：
  - 將原記錄 `is_voided=1`，記錄 `void_reason`、`voided_by`、`voided_at`
  - 自動建立反向調整記錄（`is_void_reversal=1`，連結 `void_source_id`）
  - 入庫作廢 → 建立反向出庫；出庫作廢 → 建立反向入庫
- 視覺標示：
  - 已作廢：半透明灰底 + 刪除線 + 紅色「✕ 已作廢」標籤 + 顯示作廢原因/人員/時間
  - 作廢調整：淡黃底 + 橘色「⚙️ 作廢調整」標籤
- 篩選器新增「已作廢」選項

**6. Email 通知（nodemailer）**
- 庫存異動、借測到期時自動發送 Email 通知
- Email 設定頁（`/settings/email`）可設定 SMTP 主機、帳號密碼

**7. 首次登入強制改密碼**
- 新增使用者時可勾選「首次登入強制改密碼」
- `users.force_password_change = 1` 時登入後強制導向改密碼頁面

---

### 2026-01-12 — UI/UX 大幅優化

#### 響應式設計重構
- 桌面版：固定左側側邊欄（250px），含分組導航
- 手機版：頂部固定工具列 + 底部導航列（5個常用功能）+ 點「更多」滑出完整側邊欄
- 統一設計系統（CSS 變數、Indigo 主色調）

#### 共用組件
- `_common-nav.ejs`：統一導航欄結構
- `_common-styles.ejs`：設計系統 v3.0（CSS 變數 + 響應式佈局）
- `_common-nav-script.ejs`：側邊欄互動腳本
- `_common-mobile-script`：手機版表格轉卡片通用腳本

---

## 專案結構

```
inv/
├── server.js              主程式：DB 初始化、middleware、排程、路由掛載、優雅關閉
├── lib/                   共用模組
│   ├── config.js          設定載入（env）+ 啟動驗證 + 時區設定
│   ├── logger.js          結構化 logger（level、可選 log file）
│   ├── sql.js             庫存計算 SQL 片段 + prepared statement 快取
│   ├── helpers.js         flash / logActivity / 系統設定 / 權限
│   ├── email.js           escapeHtml / buildEmailHtml / 寄信
│   ├── uploads.js         multer（Excel 匯入 / 料件圖片）
│   ├── auth.js            requireAuth / requireAdmin / 全域守門 / buildSessionUser
│   ├── security.js        Origin 檢查 / 登入 rate limit / 安全標頭
│   ├── validators.js      輸入驗證規則
│   └── sso.js             M365/Entra OIDC（MSAL）+ email 比對
├── routes/                依領域分檔的路由（auth/sso/dashboard/parts/movements/
│                          inventory-check/invoices/reports/users/roles/settings/
│                          activity-logs/backup/categories/units/system）
├── tests/                 單元測試
│   └── integration/       整合測試（supertest + :memory: SQLite）
├── views/                 EJS 模板
└── .github/workflows/ci.yml   GitHub Actions CI
```

---

## 環境變數（.env）

| 變數 | 預設 | 說明 |
|------|------|------|
| `PORT` | 5000 | 監聽埠 |
| `NODE_ENV` | development | `production` 時 SESSION_SECRET 必填、cookie 預設 secure |
| `SESSION_SECRET` | （開發隨機） | 生產環境必填，長度 ≥ 32（`openssl rand -hex 32`） |
| `SESSION_MAX_AGE_MINUTES` | 1440 | session cookie 有效時間 |
| `COOKIE_SECURE` | prod=true | cookie 僅走 HTTPS |
| `COOKIE_SAMESITE` | lax | SSO 回呼需 `lax`；可設 strict/lax/none |
| `DB_FILE` | inventory.db | 主資料庫檔；測試用 `:memory:` |
| `SESSION_DB_FILE` | sessions.db | session 持久化檔 |
| `BACKUP_DIR` | ./backups | 備份目錄 |
| `BACKUP_RETENTION_DAYS` / `BACKUP_RETENTION_MIN_FILES` | 30 / 7 | 備份保留策略 |
| `ACTIVITY_LOG_RETENTION_DAYS` | 90 | 操作紀錄保留天數（0=不清理） |
| `LOGIN_RATE_LIMIT_WINDOW_MS` / `LOGIN_RATE_LIMIT_MAX` | 900000 / 10 | 登入頻率限制 |
| `ALLOWED_HOSTS` | （空） | Origin 檢查額外容許 host（逗號分隔；反向代理 host 不一致時用） |
| `LOG_FILE` / `LOG_LEVEL` | null / info | log 寫檔路徑 / 等級 |
| `TZ` | Asia/Taipei | 時區（一般不需改） |
| `SSO_TENANT_ID` | — | Entra 租戶 ID（設齊四項才啟用 SSO） |
| `SSO_CLIENT_ID` | — | Entra 應用程式（用戶端）ID |
| `SSO_CLIENT_SECRET` | — | Entra 用戶端密碼 |
| `SSO_REDIRECT_URI` | — | 重新導向 URI，需與 Entra 設定完全一致 |

---

## M365 SSO 設定

### Entra App Registration
1. Azure Portal → Microsoft Entra ID → App registrations → New registration
2. **Redirect URI**（平台選 Web）填 `https://你的網域/auth/callback`，需與 `SSO_REDIRECT_URI` 完全一致
3. API permissions：Microsoft Graph 委派權限 `openid`、`profile`、`email`（通常預設已有）
4. Certificates & secrets → New client secret → 複製密碼值

### 系統設定
1. `.env` 填入 `SSO_TENANT_ID`、`SSO_CLIENT_ID`、`SSO_CLIENT_SECRET`、`SSO_REDIRECT_URI`
2. `npm install`（安裝 `@azure/msal-node`）後重啟
3. 登入頁會出現「使用 Microsoft 365 登入」按鈕

### 綁定使用者
- 在「人員管理」新增/編輯使用者，將**電子郵件**欄位填入該員的 **M365 登入信箱**
- SSO 登入時以此 email 比對（不分大小寫），相符且帳號啟用中才放行
- 政策：不自動建帳號；建議至少保留一個本地 admin 帳號當後門

### 注意
- SSO 實務上必須 HTTPS（Entra 除 `localhost` 外只接受 https Redirect URI）
- 反向代理終結 TLS 時，`server.js` 已設 `app.set('trust proxy', 1)`

---

## 資料庫 Schema 重要欄位說明

### `parts`
| 欄位 | 類型 | 說明 |
|------|------|------|
| `image_path` | TEXT | 料件圖片相對路徑（如 `/uploads/parts/1_xxx.jpg`），NULL 表示無圖片 |

### `inbound_records`
| 欄位 | 類型 | 說明 |
|------|------|------|
| `is_return` | INTEGER | 1=歸還借測記錄 |
| `return_outbound_id` | INTEGER | 連結的原始出庫記錄 ID（歸還時使用） |
| `is_voided` | INTEGER | 1=已作廢 |
| `void_reason` | TEXT | 作廢原因 |
| `voided_by` | TEXT | 作廢操作人 |
| `voided_at` | TIMESTAMP | 作廢時間 |
| `is_void_reversal` | INTEGER | 1=系統自動建立的反向調整記錄 |
| `void_source_id` | INTEGER | 連結的原始被作廢記錄 ID |
| `created_by` | TEXT | 建立人員 |

### `outbound_records`
| 欄位 | 類型 | 說明 |
|------|------|------|
| `is_loan` | INTEGER | 1=借測出庫 |
| `loan_due_date` | DATE | 借測到期日 |
| `converted_from_loan` | INTEGER | 1=由借測轉為正式出庫 |
| `has_invoice` | INTEGER | 1=已有發票號碼 |
| `invoice_number` | TEXT | 發票號碼（快速記錄用） |
| `is_voided` | INTEGER | 1=已作廢 |
| `void_reason` | TEXT | 作廢原因 |
| `voided_by` | TEXT | 作廢操作人 |
| `voided_at` | TIMESTAMP | 作廢時間 |
| `is_void_reversal` | INTEGER | 1=系統自動建立的反向調整記錄 |
| `void_source_id` | INTEGER | 連結的原始被作廢記錄 ID |
| `created_by` | TEXT | 建立人員 |

### `invoices`
| 欄位 | 類型 | 說明 |
|------|------|------|
| `invoice_number` | TEXT | 發票號碼 |
| `status` | TEXT | `pending` / `issued` / `paid` |
| `customer_name` | TEXT | 客戶名稱 |
| `payment_due_date` | DATE | 付款到期日 |
| `total_amount` | REAL | 發票總金額 |
| `note` | TEXT | 備註 |
| `created_by` | TEXT | 建立人員 |

### `invoice_items`
| 欄位 | 類型 | 說明 |
|------|------|------|
| `invoice_id` | INTEGER | 關聯的發票 ID |
| `outbound_id` | INTEGER | 關聯的出庫記錄 ID |
| `part_id` | INTEGER | 料件 ID |
| `quantity` | INTEGER | 數量 |
| `unit_price` | REAL | 單價 |
| `amount` | REAL | 小計（quantity × unit_price） |

---

## API 端點說明

### 出庫相關
| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/outbound-records/:part_id` | 取得料件的可退回出庫記錄（含剩餘可退回數量） |
| POST | `/outbound/:id/void` | 作廢出庫記錄（管理員） |

### 入庫相關
| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/inbound` | 新增入庫記錄（含退回出庫、歸還借測） |
| POST | `/inbound/:id/void` | 作廢入庫記錄（管理員） |

### 發票相關
| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/invoices` | 發票列表 |
| GET | `/invoices/add` | 新增發票頁面 |
| POST | `/invoices/add` | 建立發票 |
| GET | `/invoices/:id` | 發票詳情 |
| POST | `/invoices/:id/status` | 更新發票狀態 |

### 發票相關（新增編輯功能）
| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/invoices/:id/edit` | 發票編輯頁面（預填現有資料） |
| POST | `/invoices/:id/edit` | 更新發票（transaction 保證原子性） |

### 料件圖片相關
| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/parts/:id/upload-image` | 上傳/更換料件圖片（multer，15 MB 上限） |
| POST | `/parts/:id/delete-image` | 刪除料件圖片並清除 DB 欄位 |

### QR Code 相關
| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/qr?text=...` | 伺服器端產生 QR Code，回傳 PNG data URI（JSON） |

### 通知相關
| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/loan-notifications` | 取得借測到期通知列表 |

### 認證 / SSO
| 方法 | 路徑 | 說明 |
|------|------|------|
| GET/POST | `/login` | 帳密登入頁 / 處理（含 rate limit） |
| POST | `/logout` | 登出 |
| GET | `/auth/sso` | 發起 M365 SSO（導向 Entra；未啟用時導回登入頁） |
| GET | `/auth/callback` | M365 OIDC 回呼（驗 state → 換 token → 比對 email → 建 session） |

### 系統 / 維運
| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/healthz` | 公開健康檢查（不需登入，回 `{ok,ts}`） |
| GET | `/health` | 系統健康狀態頁（管理員） |
| POST | `/api/admin/cleanup-activity-logs` | 手動清理操作紀錄（管理員） |

---

## 權限控制

| 功能 | 一般使用者 | 管理員 |
|------|-----------|--------|
| 出入庫 | ✅ | ✅ |
| 作廢記錄 | ❌ | ✅ |
| 發票管理 | ✅ | ✅ |
| 人員管理 | ❌ | ✅ |
| 備份管理 | ❌ | ✅ |
| 系統設定 | ❌ | ✅ |

---

## 注意事項

- 所有資料庫 schema 變更採用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 模式，透過 `columnExists()` 函數檢查，確保不破壞現有資料。
- 作廢操作使用 `db.transaction()` 包裝，確保標記作廢與建立反向記錄的原子性。
- 入庫表單使用固定 hidden input（`final_is_return`、`final_return_outbound_id`）作為實際送出欄位，其他同名 UI 元素不帶 `name` 屬性，避免表單多值衝突。
- 圖片上傳需於 NGINX 設定 `client_max_body_size 20M;` 及適當的 `proxy_read_timeout`，否則大檔案（手機拍照）會在到達 Node.js 之前被 NGINX 拒絕（HTTP 413）。
- QR Code 改用伺服器端 `qrcode` npm 套件產生，避免前端 canvas/table 渲染受全域 CSS 干擾。
- 靜態檔案（料件圖片）透過 `app.use('/public', express.static(...))` 提供，圖片 URL 格式為 `/public/uploads/parts/<filename>`。
- `views/_qrcode-js.ejs` 為舊版前端 QR Code 函式庫備份，目前已改用伺服器端產生，此檔案保留備用。
