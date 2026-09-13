/* eslint-disable camelcase */

exports.shorthands = undefined;

// ข้อมูลติดต่อที่เจ้าตัวแก้ไขเอง (mdm.person_contact) และผู้ติดต่อฉุกเฉิน (mdm.emergency_contact) - §1.2, §1.4
exports.up = (pgm) => {
  pgm.createTable(
    { schema: 'mdm', name: 'person_contact' },
    {
      person_id: {
        type: 'uuid',
        primaryKey: true,
        references: { schema: 'mdm', name: 'person' },
        onDelete: 'CASCADE',
      },
      mobile_phone: { type: 'varchar(20)' },
      phone_alt: { type: 'varchar(20)' },
      email_personal: { type: 'varchar(255)' },
      line_id: { type: 'varchar(100)' },
      same_as_registered: { type: 'boolean', notNull: true, default: true },
      cur_address_text: { type: 'text' },
      cur_subdistrict_code: { type: 'varchar(10)' },
      cur_district_code: { type: 'varchar(10)' },
      cur_province_code: { type: 'varchar(10)' },
      cur_postcode: { type: 'varchar(10)' },
      updated_by: { type: 'varchar(10)', check: "updated_by IN ('SELF', 'HR')" },
      updated_at: { type: 'timestamptz' },
    }
  );

  pgm.createTable(
    { schema: 'mdm', name: 'emergency_contact' },
    {
      emergency_contact_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      person_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'mdm', name: 'person' },
        onDelete: 'CASCADE',
      },
      full_name: { type: 'varchar(200)', notNull: true },
      relationship: { type: 'varchar(50)' },
      phone: { type: 'varchar(20)' },
      priority: { type: 'integer', notNull: true, default: 1 },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    }
  );
  pgm.createIndex({ schema: 'mdm', name: 'emergency_contact' }, 'person_id');
  // ER 1/2: 1 - 0..3 emergency_contact ต่อคน
  pgm.addConstraint(
    { schema: 'mdm', name: 'emergency_contact' },
    'emergency_contact_priority_range_ck',
    'CHECK (priority BETWEEN 1 AND 3)'
  );
  pgm.createIndex({ schema: 'mdm', name: 'emergency_contact' }, ['person_id', 'priority'], {
    unique: true,
    name: 'emergency_contact_person_priority_uk',
  });
};

exports.down = (pgm) => {
  pgm.dropTable({ schema: 'mdm', name: 'emergency_contact' });
  pgm.dropTable({ schema: 'mdm', name: 'person_contact' });
};
