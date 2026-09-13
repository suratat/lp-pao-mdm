/* eslint-disable camelcase */

exports.shorthands = undefined;

// โครงสร้างส่วนราชการ (mdm.org_unit, self-reference) และกรอบอัตรากำลัง (mdm.position) - §1.2, §1.4
exports.up = (pgm) => {
  pgm.createTable(
    { schema: 'mdm', name: 'org_unit' },
    {
      org_unit_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      parent_id: {
        type: 'uuid',
        references: { schema: 'mdm', name: 'org_unit' },
        onDelete: 'RESTRICT',
      },
      code: { type: 'varchar(50)', notNull: true },
      name_th: { type: 'varchar(255)', notNull: true },
      name_en: { type: 'varchar(255)' },
      unit_level: {
        type: 'varchar(20)',
        notNull: true,
        check: "unit_level IN ('สำนัก/กอง', 'ฝ่าย', 'งาน')",
      },
      is_active: { type: 'boolean', notNull: true, default: true },
      valid_from: { type: 'date' },
      valid_to: { type: 'date' },
    }
  );
  pgm.createIndex({ schema: 'mdm', name: 'org_unit' }, 'code', { unique: true });
  pgm.createIndex({ schema: 'mdm', name: 'org_unit' }, 'parent_id');

  pgm.createTable(
    { schema: 'mdm', name: 'position' },
    {
      position_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      position_no: { type: 'varchar(50)', notNull: true },
      title_th: { type: 'varchar(255)', notNull: true },
      line_of_work: { type: 'varchar(100)' },
      position_type: {
        type: 'varchar(30)',
        notNull: true,
        check:
          "position_type IN ('บริหารท้องถิ่น', 'อำนวยการท้องถิ่น', 'วิชาการ', 'ทั่วไป')",
      },
      org_unit_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'mdm', name: 'org_unit' },
        onDelete: 'RESTRICT',
      },
      is_active: { type: 'boolean', notNull: true, default: true },
    }
  );
  pgm.createIndex({ schema: 'mdm', name: 'position' }, 'position_no', { unique: true });
  pgm.createIndex({ schema: 'mdm', name: 'position' }, 'org_unit_id');
};

exports.down = (pgm) => {
  pgm.dropTable({ schema: 'mdm', name: 'position' });
  pgm.dropTable({ schema: 'mdm', name: 'org_unit' });
};
