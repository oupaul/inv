# 技術文件 - 庫存管理系統

## 更新歷程

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

## 資料庫 Schema 重要欄位說明

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

### 通知相關
| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/loan-notifications` | 取得借測到期通知列表 |

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
