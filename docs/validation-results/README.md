# 规格交付校验记录

`G0-contract-validation.json` 是本次文档交付的校验结果，仅对应 JSON/OpenAPI/示例及语义一致性，不是运行平台验收。

在项目根目录可重新执行：

```bash
python3 docs/build_contracts.py
python3 -m venv .venv-docs
.venv-docs/bin/python -m pip install -r docs/requirements-docs.txt
.venv-docs/bin/python docs/validate_contracts.py
```

生成器不安装平台或调用模型。验证依赖仅用于文档维护；当前交付没有 Linux/Playwright/真实模型执行结果。后续 M0/G1–G5 成绩按验收文档单独保存，不覆盖这项记录来冒充产品通过。

## 历史报告中的命令

2026-10-10 起，根 `package.json` 只保留通用命令，阶段验收命令迁到 `scripts/acceptance-tasks.json`，任务名和命令内容不变。报告中的 `pnpm test:tNN-*` / `pnpm report:tNN` 现在用 `pnpm acceptance test:tNN-*` / `pnpm acceptance report:tNN` 运行；报告正文保持原样，作为当时的执行记录。
