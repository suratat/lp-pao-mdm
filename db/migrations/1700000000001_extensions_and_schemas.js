/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // btree_gist จำเป็นสำหรับ EXCLUDE constraint บน uuid (=) ร่วมกับ daterange (&&) ใน employment
  pgm.sql('CREATE EXTENSION IF NOT EXISTS btree_gist;');

  pgm.createSchema('mdm', { ifNotExists: true });
  pgm.createSchema('audit', { ifNotExists: true });
  pgm.createSchema('integration', { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropSchema('integration', { ifExists: true, cascade: true });
  pgm.dropSchema('audit', { ifExists: true, cascade: true });
  pgm.dropSchema('mdm', { ifExists: true, cascade: true });
  pgm.sql('DROP EXTENSION IF EXISTS btree_gist;');
};
