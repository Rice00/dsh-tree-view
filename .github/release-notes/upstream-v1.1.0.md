DSH 0.1.5-rc.2 compatibility update.

Fix seeded edit/retry creation, clear inherited pending input before publication, identify version markers by session ownership, preserve reasoning effort, and read persisted branches through disposable session observations.

修复编辑/重试的 seed 边界，发布分支前清空继承的待发送输入，按会话身份识别版本标记，保留推理强度，并通过会话观察接口恢复持久分支。

Declared DSH range: `>=0.1.5-rc.2 <0.1.6-0`. Keep the previous plugin version on DSH 0.1.2.

Validation: automated regression suite, real npm archive checks, isolated official DSH 0.1.5-rc.2 with all four plugins, offline model, and headless Edge browser acceptance. See the repository's `.github/reviews/dsh-0.1.5.md`.

Install the attached archive:

```sh
dsh plugin --profile desktop add ./dsh-tree-view-1.1.0.tgz
```

Restart DSH after updating.
