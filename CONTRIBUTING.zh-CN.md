# 参与 Recapsy

[English](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh-CN.md)

感谢你的关注。Recapsy 刻意保持很小。下面的规则用来让代码保持一致，无论改动来自人还是替人干活的编码 agent。

## 该开什么

- **Bug**：用 bug 报告表单，写清版本、macOS 版本和复现步骤。
- **功能**：动手前先开一条 [discussion](https://github.com/IM594/recapsy/discussions)。很多好想法更适合作为一段给 agent 的 prompt，而不是应用里的一个功能，先讨论清楚再写代码。没有事先讨论的功能 PR 可能会被关闭。
- **安全**：见 [SECURITY.md](SECURITY.md)，不要开公开 issue。

## 流程

1. 从 `main` 切分支，命名 `type/topic`，type 与 commit 同一套词：`feat/mcp-citations`、`fix/capture-stall-alert`、`docs/readme-install`。
2. 一个 PR 只做一件事。小而完整胜过大而残缺。
3. PR 标题写成 Conventional Commits 格式。这个标题会成为 `main` 上唯一的那个 commit，所以要精确。
4. `main` 不接受直接 push，一切改动经 squash merge 进入。

## Commit

- 格式：`type(scope): message`，一行，无 body，无 footer。
- type：`feat`、`fix`、`refactor`、`perf`、`test`、`docs`、`chore`、`ci`、`build`、`style`、`revert`。
- `feat`、`fix`、`refactor` 必须带 `scope`，scope 是模块或能力名，例如 `capture`、`ocr`、`mcp`、`summary`、`review`。

## 代码规则

- **按它为用户做的事命名。** 名字描述能力，不描述工作阶段、脚手架或实现细节，代码、测试、目录、类型和用户可见文案一律如此。
- **测试按所有权组织。** 模块测试放 `src/<module>/tests/`，跨模块集成测试放 `tests/integration/`，统一 `*.test.ts`。不用 `__tests__/`，不用 `*.spec.ts`，不把测试放在源码旁边。生产代码不得导入测试目录。Swift 保留 `Tests/<Target>Tests/`。
- **注释是最后手段。** 让命名和结构承载含义，必须写时只写一行。
- **不写死 secret、域名、端口、个人路径。**
- **解决原因，不掩盖症状。** 如果 workaround 是唯一选择，在 PR 里说明并写出取舍。
- **依赖锁版本、有意为之。** 加库先开 discussion。
- **能耗是硬指标。** 持续运行的东西必须证明自己的成本。活动监视器必须一直显示“低”。

## 本地环境

环境搭建与测试命令会随第一批代码一起补到这里。

## 许可

参与即表示你同意贡献以 [MIT 许可证](LICENSE) 发布。
