/* eslint-disable camelcase */

exports.shorthands = undefined;

// T5: deactivate -> revoke flow (§3.4, ภาคผนวก 0.5) ต้องการให้ worker แยกแยะได้ว่า event
// PERSON_DEACTIVATED แต่ละอันถูกประมวลผล revoke (check + Keycloak) แล้วหรือยัง - แยกจาก
// published_at เดิม (ซึ่งหมายถึง "fan-out ไป webhook_delivery แล้ว" คนละความหมายกัน)
exports.up = (pgm) => {
  pgm.addColumn(
    { schema: 'integration', name: 'outbox_event' },
    { revoke_processed_at: { type: 'timestamptz' } }
  );
  pgm.createIndex({ schema: 'integration', name: 'outbox_event' }, ['event_type'], {
    where: "event_type = 'PERSON_DEACTIVATED' AND revoke_processed_at IS NULL",
    name: 'outbox_event_pending_revoke_idx',
  });

  pgm.sql(`GRANT UPDATE (revoke_processed_at) ON integration.outbox_event TO mdm_worker;`);
};

exports.down = (pgm) => {
  pgm.sql(`REVOKE UPDATE (revoke_processed_at) ON integration.outbox_event FROM mdm_worker;`);
  pgm.dropIndex({ schema: 'integration', name: 'outbox_event' }, ['event_type'], {
    name: 'outbox_event_pending_revoke_idx',
  });
  pgm.dropColumn({ schema: 'integration', name: 'outbox_event' }, 'revoke_processed_at');
};
