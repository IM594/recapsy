<div align="center">

# Recapsy

**你在 Mac 上做过的一切，它都记得，也只属于你。**

[English](README.md) · [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](#它怎么工作)
[![Status: in development](https://img.shields.io/badge/status-in%20development-orange.svg)](#当前状态)

</div>

Recapsy 在本机记下你每一刻正在做的事，你或你的 agent 问起任何一刻，它都能答。现在通过 Claude Code、Cursor、Codex 走 MCP 提问，每个回答都附带截图、原文和时间。

> “把现在的我和三个月前的我比一比，正向和负向的变化都要，给我数据。”
>
> “这周我到底做完了什么？把截图给我看。”
>
> “昨天下午开会前我在看什么？”

- **桌面端永远免费、永远开源。** 不开云端档，一个字节都不出电脑。
- **云端档订阅制，用来养这个项目。** 同步、托管模型、备份、手机上问，这些收费。
- **免费过的东西永远免费。**

## 为什么

开会前十分钟，你问一句“我这周做了什么”，拿到带细节的发言稿：哪些文件、哪几个对话、哪个下午。没有它，你要在 git、Slack 和 Notion 里翻一个小时。因为它看过每一天，更大的问题也能问：这个季度我的工作有什么变化，证据是什么。agent 开工前也能先问你在这个项目干到哪了。

## 它不会骗你

关于你的数据，四条承诺。

| 底线 | 含义 |
|------|------|
| **漏了会知道** | 每段时间要么有截图，要么记下没截的原因。采集停了会提醒你。 |
| **原图可回看** | 任何时刻的截图和识别文字随时可翻，答案可以对质。 |
| **不会悄悄删** | 删除只按你看得见、改得了的规则执行。 |
| **答案给出处** | 每个回答附带截图、原文和时间。 |

## 它怎么工作

```
 屏幕 ──▶ Swift 采集 ──▶ PP-OCR（本机）──▶ SQLite + 全文索引 + 向量
                                                  │
                          段 / 日 / 周总结（你配的模型，可选）
                                                  │
                                MCP 服务 ──▶ Claude Code · Cursor · Codex
                                                  │
                                每日回顾页（给人看）
```

截图、识字、索引都在你的 Mac 上完成。总结每天跑一次，用你自己配的模型，任何 OpenAI 兼容地址或本机 Ollama 都行，不配也不影响其他功能。提问交给你自己的 agent 走 MCP，所以没有需要另学的聊天窗口。识字用 PP-OCR 本机运行，调度目标是活动监视器能耗保持“低”。只支持 macOS。

1.0 做什么、不做什么：[docs/roadmap.md](docs/roadmap.md)（英文）。

## 当前状态

开发中，尚未发布。Watch 本仓库等第一个版本。想加入云端档等待名单，请开一条 [discussion](https://github.com/IM594/recapsy/discussions)。

`main` 于 2026-09-08 从干净历史开始。2025-12 以来的原型保留在 tag `archive/prototypes-2026-09` 下。

## 参与

Bug 走 issue 表单，功能先开 discussion。首个版本发布前暂不合并外部 PR。流程与代码规则见 [CONTRIBUTING.md](CONTRIBUTING.md)（英文）。

## 许可证

[MIT](LICENSE)
