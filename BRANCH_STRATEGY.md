# 分支管理策略

## 分支命名規範

### 標準命名格式
```
<類型>/<簡短描述>
```

### 分支類型
1. **feature/** - 新功能開發
   - 範例：`feature/force-logout-setting`
   - 範例：`feature/user-notification`

2. **fix/** - Bug 修復
   - 範例：`fix/login-error`
   - 範例：`fix/export-bug`

3. **refactor/** - 重構代碼
   - 範例：`refactor/database-connection`
   - 範例：`refactor/api-structure`

4. **remove/** - 移除功能
   - 範例：`remove/backup-opt-folder`
   - 範例：`remove/legacy-api`

5. **update/** - 更新或改進現有功能
   - 範例：`update/backup-ui`
   - 範例：`update/search-performance`

## 工作流程

### 1. 從 main 分支創建新分支
```bash
git checkout main
git pull origin main
git checkout -b feature/新功能名稱
```

### 2. 開發完成後提交
```bash
git add .
git commit -m "描述性的提交訊息"
git push -u origin feature/新功能名稱
```

### 3. 合併到 main 分支

#### 方式 A：使用 Pull Request（推薦）
1. 在 GitHub 上創建 Pull Request
2. 審查代碼
3. 合併 PR

#### 方式 B：本地合併
```bash
git checkout main
git pull origin main
git merge feature/新功能名稱
git push origin main
```

### 4. 合併後清理
```bash
git branch -d feature/新功能名稱          # 刪除本地分支
git push origin --delete feature/新功能名稱  # 刪除遠程分支
```

## 當前分支狀況

### 需要重新命名的分支
- `remove-backup-features` → `remove/backup-opt-folder`

### 正確命名的分支
- `feature/force-logout-setting` ✅

## 版本標籤建議

合併到 main 後，建議打上版本標籤：
```bash
git tag -a v1.1.0 -m "版本 1.1.0：新增強制登出設定功能"
git push origin v1.1.0
```

## 最佳實踐

1. **保持 main 分支穩定**：只合併經過測試的代碼
2. **一個分支一個功能**：每個分支只處理一個功能或修復
3. **頻繁提交**：小步快跑，經常提交
4. **清晰的提交訊息**：說明為什麼修改，而不只是修改了什麼
5. **合併前測試**：確保代碼可以正常運行
