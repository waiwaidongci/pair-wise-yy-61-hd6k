# pair-wise-yy-61 航空器定检工作包执行与放行审阅平台

支持工卡依赖、测量值容差校验、离线暂存、冲突提交提示、分阶段签字、版本差异和放行锁定。超差项目必须由授权人员处理后才能继续。

工卡依赖、执行状态与放行门禁共用同一份版本关系：依赖调整成环即拒绝并指出回路；关系变更后下游工卡自动失效重算（现场测量与证据原值保留），受影响阶段签字退回；两名工艺员并发提交同一关系时先到者生效、后到者留存冲突草稿；写入失败按原请求回滚恢复；旧工作包缺少关系版本时自动兼容升级。

## 技术栈

React、Fluent UI、Redux Toolkit、React Router、RTK Query、Vite、TypeScript。

## 运行

```bash
npm install
npm run dev
```

访问 `http://localhost:62061`。工卡草稿和审计操作保存在 `localStorage`。

```bash
npm run build
```
