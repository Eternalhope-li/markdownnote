# MarkdownNote

> 一款「所见即所得」（WYSIWYG）Markdown 笔记编辑器 · 基于 Electron 构建的本地桌面应用

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-33.4.11-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20x64-0078D6?logo=windows&logoColor=white)]()

输入即排版、多标签页、全文搜索、标签管理、大纲导航、源码视图，一键导出 PDF / HTML / PNG。无账号、无云同步、不上传任何数据，笔记永远是你自己的普通 `.md` 文件。

---

## ✨ 功能特性

### 所见即所得编辑
- 行首输入 `# `、`- `、`1. `、`> `、`- [ ] `、` ``` `、`---`、`| a | b |` 后按空格或回车，**即时转换**为对应排版
- 行内输入 `**加粗**`、`*斜体*`、`***粗斜***`、`~~删除~~`、`` `代码` ``、`[链接](url)`、`![图片](url)` 即时转换
- 回车智能续写：标题下回车自动变正文、列表自动续项、引用自动续行、表格自动加行
- 退格智能降级：列表项 / 引用 / 标题退格逐级还原为普通文本
- 引号、括号、反引号**自动成对**输入

### 编辑体验
- **快照式撤销 / 重做**：`Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z`，格式转换类操作可一键还原为原始 Markdown
- 标题快捷键 `Ctrl+1~6` / `Ctrl+0`，加粗 `Ctrl+B`、斜体 `Ctrl+I`
- 代码块：语法高亮 + 行号 + 语言选择（40+ 语言），`Tab` 缩进、行尾自动补全
- 表格编辑：`Tab` 切换单元格、回车换行、表格外按 `↓` 自动退出
- 任务列表：点击复选框即切换完成状态

### 编辑体验增强
- **多标签页**：同时打开多个笔记，标签栏一键切换 / 关闭（关闭有未保存修改的标签会二次确认）
- **文件列表右键菜单**：打开 / 重命名 / 删除 / 在资源管理器中显示
- **最近文件**：侧边栏最近列表，点击即打开，可单个移除或一键清空；启动自动恢复上次打开的笔记
- **外部修改检测**：笔记被其他程序改动时提示“重新加载”，避免互相覆盖；笔记库目录变化自动刷新列表
- **崩溃恢复**：检测到较新的 .bak 备份时提示用备份恢复，断电 / 异常退出不丢内容
- **原子写入**：保存先写临时文件再 rename 覆盖，杜绝断电写坏主文件
- **大纲导航**：侧边栏自动生成标题大纲，点击跳转（支持 h1~h6）
- **源码视图**：Ctrl+Alt+S 或“源码”按钮切换 Markdown 源码 / 所见即所得，源码中改动切回即生效
- **拖拽插入**：从文件夹直接拖入图片（自动落盘 .assets）或任意文件（插入链接）
- **表格右键菜单**：插入 / 删除行列、删除整个表格
- **设置面板**：正文字号、行距、笔记库路径，即时生效并持久化
- **状态栏**：实时显示光标“第 N 行，第 M 列”
- **导出与打印**：导出为 PNG 长图、直接打印（菜单“文件”）

### 笔记管理
- 本地笔记库：所有笔记均为普通 `.md` 文件，随时可用任意编辑器打开
- 文件树 + **标题 / 标签 / 正文全文搜索**（输入即过滤）
- 标签系统（YAML front matter 头信息）
- **自动保存**：输入后约 0.8 秒自动落盘 + 失焦/隐藏立即保存 + 关机/注销/退出前强制保存，突然断电最多只丢约 1 秒输入
- **系统托盘常驻**：关闭窗口最小化到右下角托盘，后台继续运行，点托盘图标随时唤回，托盘菜单可直接新建 / 打开 / 退出
- 粘贴图片自动落盘到笔记旁的 `.assets` 目录，Markdown 保持纯净

### 外观与导出
- 明 / 暗双主题一键切换（`Ctrl+Shift+T`）
- 导出独立 HTML（内嵌样式与代码高亮，单文件可直接分享）
- 导出 PDF（专用打印样式，适合打印与归档）

---


## 🛠 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Electron 33（Chromium + Node.js） |
| 语言 | JavaScript（CommonJS）+ HTML5 + CSS3 |
| 编辑器内核 | **自研** contenteditable WYSIWYG 引擎（`src/renderer/editor.js`） |
| Markdown 渲染 | markdown-it 14 |
| HTML → Markdown | turndown 7（保存 / 粘贴转换） |
| 代码高亮 | highlight.js 11 |
| 打包分发 | electron-builder 26（NSIS 安装包） |

### 架构设计
```
┌─ 主进程（Node.js）  main.js   窗口 / 原生菜单 / 文件读写 / 对话框 / PDF 导出
├─ 桥接层             preload.js  contextBridge 安全暴露 IPC（渲染进程无 Node 权限）
└─ 渲染进程（浏览器）  src/renderer/  界面与编辑逻辑，遵循 CSP 安全策略
```

**编辑器性能设计**：编辑面板 DOM 即「唯一真相」——打开文件时用 markdown-it 一次性渲染，打字时只对光标所在块做行级局部转换，保存时整篇用 turndown 序列化。全量操作只发生在打开 / 保存两个低频点，因此**打字流畅度与文档大小无关**。

---

## 🚀 快速开始

### 方式一：直接安装（推荐）
下载 `release/MarkdownNote-Setup-0.1.0.exe` 双击安装：
- 支持自定义安装目录
- 自动创建桌面 / 开始菜单快捷方式
- 自带卸载程序

### 方式二：从源码运行
```bash
git clone https://github.com/Eternalhope-li/markdownnote.git
cd markdownnote
npm install        # 安装依赖（Electron 33.4.11）
npm start          # 启动开发模式
```

---

## 📖 使用指南

### 快捷键一览

| 快捷键 | 功能 |
|---|---|
| `Ctrl+N` / `Ctrl+O` | 新建笔记 / 打开笔记 |
| `Ctrl+S` | 保存当前笔记 |
| `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z` | 撤销 / 重做（可还原格式转换） |
| `Ctrl+B` / `Ctrl+I` / `Ctrl+U` | 加粗 / 斜体 / 下划线 |
| `Ctrl+Shift+S` | 删除线 |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | 复制为 Markdown 源码 / 粘贴为 Markdown（自动排版） |
| `` Ctrl+Shift+` `` | 行内代码 |
| `Ctrl+K` | 插入链接（弹窗输入地址） |
| `Ctrl+Shift+K` | 代码块（再按一次还原） |
| `Ctrl+Shift+Q` / `Ctrl+Shift+U` / `Ctrl+Shift+O` / `Ctrl+Shift+X` | 引用 / 无序列表 / 有序列表 / 任务列表（再按一次还原） |
| `Ctrl+1` ~ `Ctrl+6` / `Ctrl+0` | 标题 1–6 级 / 正文段落 |
| `Ctrl+=` / `Ctrl+-` | 标题升一级 / 降一级 |
| `Ctrl+L` / `Ctrl+D` / `Ctrl+Shift+D` | 选中整行 / 删除当前行 / 删除当前块 |
| `Ctrl+P` / `Ctrl+F` | 聚焦搜索（快速打开 / 查找） |
| `Ctrl+/` | 注释 / 取消注释 |
| `Ctrl+Alt+S` | 切换源码视图 |
| `Ctrl+W` | 关闭窗口（最小化到托盘） |
| `Ctrl+Shift+T` | 切换明暗主题 |
| `Tab` / `Shift+Tab` | 列表缩进 / 反缩进；表格切换单元格 |
| `Enter` / `Shift+Enter` | 智能续写 / 强制换行 |
| `Backspace` | 行首退格逐级降级（列表 / 引用 / 标题） |
| `↑` / `↓` | 代码块 / 表格边界智能退出 |

### Markdown 语法速览

| 输入 | 效果 |
|---|---|
| `# 标题` 到 `###### 标题` | 1–6 级标题 |
| `- 列表项` / `1. 列表项` | 无序 / 有序列表 |
| `- [ ] 待办` / `- [x] 完成` | 任务列表 |
| `> 引用` | 引用块 |
| `**加粗**` / `*斜体*` / `~~删除~~` | 行内格式 |
| `` `代码` `` / ` ``` ` 代码块 | 行内代码 / 代码块（含高亮） |
| `[文字](https://…)` / `![图片](url)` | 链接 / 图片 |
| `---` | 分割线 |
| `\| a \| b \|` | 表格 |

### 笔记库
- 首次启动自动使用内置示例笔记库（含欢迎与待办示例）
- 菜单「文件 → 选择笔记库文件夹」可切换到任意本地目录
- 菜单「文件 → 在资源管理器中显示笔记库」快速定位笔记文件
- 所有笔记即普通 `.md` 文件，用其他工具打开完全兼容
- 文件列表右键可重命名 / 删除 / 在资源管理器中显示；侧边栏提供最近文件
- 笔记被外部程序修改时会提示重新加载，避免互相覆盖

### 导出
- 工具栏 `HTML` / `PDF` 按钮，或菜单「文件 → 导出 HTML / PDF」
- HTML 为单文件自包含（内嵌样式与高亮），PDF 适配 A4 打印样式
- 菜单「文件 → 导出为 PNG 长图」将整篇笔记导出为一张图片；「文件 → 打印」直接打印

---

## 📂 目录结构

```
markdownnote/
├── main.js                  # Electron 主进程（窗口 / 菜单 / 文件 / 导出）
├── preload.js               # contextBridge 安全桥接层
├── package.json             # 项目配置与依赖
├── src/
│   └── renderer/            # 渲染进程源码
│       ├── editor.js        # ★ 所见即所得编辑器内核（自研，~106KB）
│       ├── files.js         # 笔记库管理 / 多标签 / 自动保存 / 最近文件
│       ├── search.js        # 全文搜索
│       ├── frontmatter.js   # YAML 标签解析
│       ├── themes.js        # 明暗主题
│       ├── export.js        # HTML / PDF 导出
│       ├── paste-image.js   # 图片粘贴落盘
│       ├── preview.js       # markdown-it 渲染封装 + 高亮
│       └── …                # 其余 UI / 状态模块
├── tools/                   # 构建脚本、图标生成、冒烟测试
├── samples/                 # 安装时随包分发的示例笔记
├── build/                   # 打包资源（icon.ico 等）
└── dist/                    # 构建产物（打包时生成）
```

---

## 📦 打包发布

```bash
npm run dist
```

产出 `release/MarkdownNote-Setup-0.1.0.exe`（NSIS 安装包）：
- 自定义安装目录、桌面 / 开始菜单快捷方式
- 卸载程序「卸载 MarkdownNote」
- 应用信息（作者 / 版本 / 图标）已写入可执行文件

> 提示：`package.json` 中 `electronDist` 指向本地 `node_modules/electron/dist`，打包时无需从 GitHub 下载 Electron，避免网络超时。

---

## 🧪 测试

```bash
npm run smoke
```

`tools/smoke-code.js` 在真实应用中执行冒烟测试，覆盖全部所见即所得文本操作：
标题 / 列表 / 引用 / 任务 / 行内格式 / 表格 / 代码块 / 分割线 / 退格降级 / 撤销重做 / 图片缩放 / 粘贴转换 / 保存往返。

---

## 📄 许可证

[MIT](LICENSE) © 2026 eternalhope
