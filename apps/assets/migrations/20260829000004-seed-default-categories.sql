-- Preset categories so the category filter/search is usable out of the box.
-- Idempotent: re-runs and existing user categories with the same name are kept.
INSERT INTO categories (id, name) VALUES
  (gen_random_uuid(), '电子设备'),
  (gen_random_uuid(), '工具'),
  (gen_random_uuid(), '服饰配件'),
  (gen_random_uuid(), '书籍资料'),
  (gen_random_uuid(), '文件证件'),
  (gen_random_uuid(), '其他')
ON CONFLICT (name) DO NOTHING;
