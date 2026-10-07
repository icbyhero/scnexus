import { app } from "electron";

// 必须在任何模块加载期读取 app.getPath("userData") 之前执行
// （electron-store 在模块顶层即读取 userData）。
// 包名 "@scnexus/app-main" 会让数据目录变成 "@scnexus/app-main"，
// 这里统一为正常的 "SCNexus"。
if (process.platform === "darwin") {
  app.setName("SCNexus");
}
