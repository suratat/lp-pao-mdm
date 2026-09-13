/* eslint-disable camelcase */

exports.shorthands = undefined;

// ประวัติการปฏิบัติงาน (mdm.employment) - §1.2, §1.4, §1.6
exports.up = (pgm) => {
  pgm.createTable(
    { schema: 'mdm', name: 'employment' },
    {
      employment_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      person_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'mdm', name: 'person' },
        onDelete: 'RESTRICT',
      },
      employee_no: { type: 'varchar(50)', notNull: true },
      personnel_type: {
        type: 'varchar(30)',
        notNull: true,
        check:
          "personnel_type IN ('ข้าราชการ อบจ.', 'ลูกจ้างประจำ', 'พนักงานจ้าง', 'ถ่ายโอน')",
      },
      position_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'mdm', name: 'position' },
        onDelete: 'RESTRICT',
      },
      org_unit_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'mdm', name: 'org_unit' },
        onDelete: 'RESTRICT',
      },
      level_code: { type: 'varchar(50)' },
      appointed_date: { type: 'date' },
      effective_from: { type: 'date', notNull: true },
      effective_to: { type: 'date' }, // null = current
      is_current: { type: 'boolean', notNull: true, default: true },
      employment_status: {
        type: 'varchar(20)',
        notNull: true,
        default: 'ACTIVE',
        check:
          "employment_status IN ('ACTIVE', 'TRANSFERRED_OUT', 'RESIGNED', 'RETIRED', 'TERMINATED', 'DECEASED')",
      },
      separation_date: { type: 'date' },
      separation_reason: { type: 'varchar(255)' },
      email_work: { type: 'varchar(255)' },
      hr_source_ref: { type: 'varchar(100)' },
      updated_by: { type: 'varchar(100)', notNull: true },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    }
  );

  pgm.createIndex({ schema: 'mdm', name: 'employment' }, 'person_id', {
    where: 'is_current',
    name: 'employment_person_current_idx',
  });
  pgm.createIndex({ schema: 'mdm', name: 'employment' }, ['org_unit_id', 'is_current']);

  // §1.6: UNIQUE (employee_no) WHERE is_current
  pgm.createIndex({ schema: 'mdm', name: 'employment' }, 'employee_no', {
    unique: true,
    where: 'is_current',
    name: 'employment_employee_no_current_uk',
  });

  // §1.6: ตำแหน่งหนึ่งมีผู้ครองได้หนึ่งคนในช่วงเวลาหนึ่ง (เฉพาะสถานะ ACTIVE)
  pgm.addConstraint(
    { schema: 'mdm', name: 'employment' },
    'employment_position_no_overlap_excl',
    'EXCLUDE USING gist (position_id WITH =, daterange(effective_from, effective_to) WITH &&) WHERE (employment_status = \'ACTIVE\')'
  );
};

exports.down = (pgm) => {
  pgm.dropTable({ schema: 'mdm', name: 'employment' });
};
