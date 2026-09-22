# 培养方案知识库运行数据

这个目录是课程规划服务独立维护的共享培养方案分区，不保存学生成绩单、姓名、学号或已修课程。

运行时会生成以下未纳入 Git 的内容：

```text
documents/    # 受控上传后复制的培养方案 PDF 或图片
catalogs/     # 模型提取、校验和复核后的结构化课程目录记录
index.json    # 文档索引；可按专业、年级和版本筛选
```

`clear_curriculum_knowledge_base(confirm=true)` 只清理本目录中的运行数据；它不会触碰
`course-path-server/data/course_catalog.json`，更不会影响 `policy-search` 的知识库。

已提取的目录在这里属于候选记录。即使状态为 `AUTO_VERIFIED`，也不会自动覆盖公共
`course_catalog.json`，以保持课程规划规则可追溯。
