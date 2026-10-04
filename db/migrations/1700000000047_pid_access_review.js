/* eslint-disable camelcase */

exports.shorthands = undefined;

// PR-B (DPO): บันทึกผลรีวิวการเปิดเลขบัตร (GET /persons/{id}/pid ที่เขียน audit.access_log พร้อม justification)
//
// - append-only เหมือนตารางอื่นใน schema audit (trigger + REVOKE UPDATE/DELETE): การรีวิวซ้ำ = เพิ่มแถวใหม่ แถวล่าสุด
//   (review_id สูงสุดของ access_id+accessed_at นั้น) คือสถานะปัจจุบัน
// - สถานะ PENDING "ไม่เก็บเป็นแถว" = ยังไม่มีแถวรีวิวของรายการนั้น (คำนวณตอนอ่านด้วย LEFT JOIN LATERAL) ไม่ต้องให้ trigger/worker
//   สร้างแถว PENDING ตอนเปิด pid และสถานะไม่คลาดเคลื่อนจากความจริง
// - อ้างอิง access_log ด้วย (access_id, accessed_at) เพราะ PK ของตาราง partition เป็น composite (access_id เดี่ยวๆ ไม่ถูกบังคับให้ unique
//   ข้าม partition) และ "ไม่ใช้ FK" โดยตั้งใจ: FK ไป partitioned table ทำให้ DROP/DETACH partition เก่าตามนโยบายเก็บ log ไม่ได้
//   เมื่อมีรีวิวอ้างอยู่ - API ตรวจว่ารายการมีจริงและเป็นการเปิด pid ด้วย INSERT ... SELECT ... FROM audit.access_log ในคำสั่งเดียว
exports.up = (pgm) => {
  pgm.createTable(
    { schema: 'audit', name: 'pid_access_review' },
    {
      review_id: { type: 'bigserial', primaryKey: true },
      access_id: { type: 'bigint', notNull: true },
      accessed_at: { type: 'timestamptz', notNull: true },
      status: { type: 'varchar(20)', notNull: true, check: "status IN ('REVIEWED', 'NEEDS_EXPLANATION')" },
      note: { type: 'text' },
      reviewer_sub: { type: 'varchar(255)', notNull: true },
      reviewer_client: { type: 'varchar(255)' },
      reviewed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    {
      constraints: {
        // ขอคำชี้แจงต้องมีข้อความระบุว่าต้องการให้ชี้แจงอะไร
        check: "status <> 'NEEDS_EXPLANATION' OR length(btrim(coalesce(note, ''))) > 0",
      },
    }
  );
  pgm.createIndex({ schema: 'audit', name: 'pid_access_review' }, ['access_id', 'accessed_at', { name: 'review_id', sort: 'DESC' }], {
    name: 'pid_access_review_access_idx',
  });

  pgm.sql(`
    CREATE TRIGGER pid_access_review_append_only
    BEFORE UPDATE OR DELETE ON audit.pid_access_review
    FOR EACH ROW EXECUTE FUNCTION audit.reject_update_delete();
  `);

  // ตารางใหม่ไม่ถูกครอบด้วย GRANT ... ON ALL TABLES ของ 0015_grants.js (มีผลเฉพาะตารางที่มีอยู่ตอนนั้น)
  // API ใช้ mdm_app เขียน/อ่าน; mdm_audit อ่านอย่างเดียว; mdm_worker ไม่ต้องใช้ใน PR นี้
  pgm.sql(`GRANT SELECT, INSERT ON audit.pid_access_review TO mdm_app;`);
  pgm.sql(`REVOKE UPDATE, DELETE ON audit.pid_access_review FROM mdm_app;`);
  pgm.sql(`GRANT USAGE ON SEQUENCE audit.pid_access_review_review_id_seq TO mdm_app;`);
  pgm.sql(`GRANT SELECT ON audit.pid_access_review TO mdm_audit;`);
};

exports.down = (pgm) => {
  pgm.sql(`REVOKE ALL ON audit.pid_access_review FROM mdm_app, mdm_audit;`);
  pgm.sql(`DROP TRIGGER IF EXISTS pid_access_review_append_only ON audit.pid_access_review;`);
  pgm.dropTable({ schema: 'audit', name: 'pid_access_review' });
};
