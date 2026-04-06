import type { Migration } from "../runner";

export const migration001: Migration = {
  version: 1,
  name: "initial_schema",
  async up(db) {
    // Analyzers (must be defined before indexes that reference them)
    await db.query(`
      DEFINE ANALYZER IF NOT EXISTS ocr_analyzer
        TOKENIZERS class, blank
        FILTERS lowercase, snowball(english);

      DEFINE ANALYZER IF NOT EXISTS cjk_analyzer
        TOKENIZERS blank
        FILTERS lowercase;
    `);

    // screenshot table
    await db.query(`
      DEFINE TABLE screenshot SCHEMAFULL;

      DEFINE FIELD path             ON screenshot TYPE string;
      DEFINE FIELD timestamp        ON screenshot TYPE datetime;
      DEFINE FIELD app_name         ON screenshot TYPE string;
      DEFINE FIELD bundle_id        ON screenshot TYPE string;
      DEFINE FIELD window_title     ON screenshot TYPE string;
      DEFINE FIELD display_id       ON screenshot TYPE int;
      DEFINE FIELD ocr_text         ON screenshot TYPE option<string>;
      DEFINE FIELD ocr_text_tokenized ON screenshot TYPE option<string>;
      DEFINE FIELD is_active        ON screenshot TYPE bool;
      DEFINE FIELD diff_ratio       ON screenshot TYPE float;
      DEFINE FIELD resolution       ON screenshot TYPE string;
      DEFINE FIELD file_size        ON screenshot TYPE int;
      DEFINE FIELD status           ON screenshot TYPE string DEFAULT 'queued';
      DEFINE FIELD retry_count      ON screenshot TYPE int DEFAULT 0;
      DEFINE FIELD last_error       ON screenshot TYPE option<string>;
      DEFINE FIELD ocr_truncated    ON screenshot TYPE bool DEFAULT false;
      DEFINE FIELD purged           ON screenshot TYPE bool DEFAULT false;
      DEFINE FIELD vision_pending   ON screenshot TYPE bool DEFAULT false;
      DEFINE FIELD embedding        ON screenshot TYPE option<array<float>>;
      DEFINE FIELD embedding_model  ON screenshot TYPE string DEFAULT 'bge-m3-v1';
      DEFINE FIELD image_embedding  ON screenshot TYPE option<array<float>>;
      DEFINE FIELD image_embedding_model ON screenshot TYPE option<string>;
      DEFINE FIELD timezone         ON screenshot TYPE string;
      DEFINE FIELD local_date       ON screenshot TYPE string;
      DEFINE FIELD local_hour       ON screenshot TYPE int;
      DEFINE FIELD capture_id       ON screenshot TYPE string;
      DEFINE FIELD created_at       ON screenshot TYPE datetime DEFAULT time::now();
    `);

    // screenshot indexes
    await db.query(`
      DEFINE INDEX idx_screenshot_timestamp ON screenshot FIELDS timestamp;
      DEFINE INDEX idx_screenshot_app       ON screenshot FIELDS app_name;
      DEFINE INDEX idx_screenshot_status    ON screenshot FIELDS status;
      DEFINE INDEX idx_screenshot_bundle    ON screenshot FIELDS bundle_id;
      DEFINE INDEX idx_screenshot_capture   ON screenshot FIELDS capture_id UNIQUE;
      DEFINE INDEX idx_screenshot_local     ON screenshot FIELDS local_date, local_hour;
    `);

    // screenshot FTS indexes
    await db.query(`
      DEFINE INDEX idx_screenshot_fts ON screenshot FIELDS ocr_text
        FULLTEXT ANALYZER ocr_analyzer BM25;
      DEFINE INDEX idx_screenshot_fts_cjk ON screenshot FIELDS ocr_text_tokenized
        FULLTEXT ANALYZER cjk_analyzer BM25;
    `);

    // screenshot HNSW vector index
    await db.query(`
      DEFINE INDEX idx_screenshot_vec ON screenshot FIELDS embedding
        HNSW DIMENSION 1024 DIST COSINE;
    `);

    // entity table
    await db.query(`
      DEFINE TABLE entity SCHEMAFULL;

      DEFINE FIELD type         ON entity TYPE string
        ASSERT $value IN ['person', 'app', 'url', 'topic', 'project', 'file', 'email'];
      DEFINE FIELD name         ON entity TYPE string;
      DEFINE FIELD aliases      ON entity TYPE option<array<string>>;
      DEFINE FIELD metadata     ON entity TYPE option<object>;
      DEFINE FIELD first_seen   ON entity TYPE datetime;
      DEFINE FIELD last_seen    ON entity TYPE datetime;
      DEFINE FIELD frequency    ON entity TYPE int DEFAULT 0;
      DEFINE FIELD embedding    ON entity TYPE option<array<float>>;
      DEFINE FIELD embedding_model ON entity TYPE string DEFAULT 'bge-m3-v1';
      DEFINE FIELD created_at   ON entity TYPE datetime DEFAULT time::now();

      DEFINE INDEX idx_entity_type      ON entity FIELDS type;
      DEFINE INDEX idx_entity_name      ON entity FIELDS name;
      DEFINE INDEX idx_entity_type_name ON entity FIELDS type, name UNIQUE;
      DEFINE INDEX idx_entity_freq      ON entity FIELDS frequency;
      DEFINE INDEX idx_entity_vec       ON entity FIELDS embedding
        HNSW DIMENSION 1024 DIST COSINE;
    `);

    // activity_segment table
    await db.query(`
      DEFINE TABLE activity_segment SCHEMAFULL;

      DEFINE FIELD app_name        ON activity_segment TYPE string;
      DEFINE FIELD bundle_id       ON activity_segment TYPE string;
      DEFINE FIELD display_ids     ON activity_segment TYPE array<int>;
      DEFINE FIELD session_start   ON activity_segment TYPE datetime;
      DEFINE FIELD session_end     ON activity_segment TYPE datetime;
      DEFINE FIELD duration_seconds ON activity_segment TYPE int;
      DEFINE FIELD activity        ON activity_segment TYPE string;
      DEFINE FIELD scene_type      ON activity_segment TYPE string
        ASSERT $value IN ['coding', 'chatting', 'browsing', 'designing', 'meeting', 'reading', 'writing', 'terminal', 'other'];
      DEFINE FIELD summary         ON activity_segment TYPE string;
      DEFINE FIELD visual_elements ON activity_segment TYPE array;
      DEFINE FIELD key_entities    ON activity_segment TYPE array;
      DEFINE FIELD activity_tokenized ON activity_segment TYPE option<string>;
      DEFINE FIELD summary_tokenized  ON activity_segment TYPE option<string>;
      DEFINE FIELD screenshot_ids  ON activity_segment TYPE array;
      DEFINE FIELD frame_count     ON activity_segment TYPE int;
      DEFINE FIELD selected_frame_count ON activity_segment TYPE int;
      DEFINE FIELD embedding       ON activity_segment TYPE option<array<float>>;
      DEFINE FIELD embedding_model ON activity_segment TYPE string DEFAULT 'bge-m3-v1';
      DEFINE FIELD schema_version  ON activity_segment TYPE int DEFAULT 1;
      DEFINE FIELD timezone        ON activity_segment TYPE string;
      DEFINE FIELD local_date      ON activity_segment TYPE string;
      DEFINE FIELD llm_model       ON activity_segment TYPE string;
      DEFINE FIELD llm_tokens_in   ON activity_segment TYPE int;
      DEFINE FIELD llm_tokens_out  ON activity_segment TYPE int;
      DEFINE FIELD processed_at    ON activity_segment TYPE datetime DEFAULT time::now();
    `);

    // activity_segment indexes
    await db.query(`
      DEFINE INDEX idx_segment_time  ON activity_segment FIELDS session_start;
      DEFINE INDEX idx_segment_app   ON activity_segment FIELDS bundle_id, session_start;
      DEFINE INDEX idx_segment_scene ON activity_segment FIELDS scene_type;
      DEFINE INDEX idx_segment_embedding ON activity_segment FIELDS embedding
        HNSW DIMENSION 1024 DIST COSINE;
    `);

    // activity_segment FTS indexes
    await db.query(`
      DEFINE INDEX idx_segment_activity_fts ON activity_segment FIELDS activity
        FULLTEXT ANALYZER ocr_analyzer BM25;
      DEFINE INDEX idx_segment_summary_fts ON activity_segment FIELDS summary
        FULLTEXT ANALYZER ocr_analyzer BM25;
      DEFINE INDEX idx_segment_activity_cjk ON activity_segment FIELDS activity_tokenized
        FULLTEXT ANALYZER cjk_analyzer BM25;
      DEFINE INDEX idx_segment_summary_cjk ON activity_segment FIELDS summary_tokenized
        FULLTEXT ANALYZER cjk_analyzer BM25;
    `);

    // settings table
    await db.query(`
      DEFINE TABLE settings SCHEMAFULL;
      DEFINE FIELD key        ON settings TYPE string;
      DEFINE FIELD value      ON settings TYPE any;
      DEFINE FIELD updated_at ON settings TYPE datetime DEFAULT time::now();
      DEFINE INDEX idx_settings_key ON settings FIELDS key UNIQUE;
    `);

    // Graph relation: appeared_in (entity -> screenshot)
    await db.query(`
      DEFINE TABLE appeared_in SCHEMAFULL TYPE RELATION IN entity OUT screenshot;
      DEFINE FIELD timestamp  ON appeared_in TYPE datetime;
      DEFINE FIELD confidence ON appeared_in TYPE float;
      DEFINE FIELD context    ON appeared_in TYPE option<string>;
      DEFINE FIELD created_at ON appeared_in TYPE datetime DEFAULT time::now();
      DEFINE INDEX idx_appeared_time ON appeared_in FIELDS timestamp;
      DEFINE INDEX idx_appeared_in   ON appeared_in FIELDS in;
      DEFINE INDEX idx_appeared_out  ON appeared_in FIELDS out;
    `);

    // Graph relation: appeared_in_segment (entity -> activity_segment)
    await db.query(`
      DEFINE TABLE appeared_in_segment SCHEMAFULL TYPE RELATION IN entity OUT activity_segment;
      DEFINE FIELD source     ON appeared_in_segment TYPE string;
      DEFINE FIELD confidence ON appeared_in_segment TYPE float;
      DEFINE FIELD created_at ON appeared_in_segment TYPE datetime DEFAULT time::now();
      DEFINE INDEX idx_ais_out ON appeared_in_segment FIELDS out;
      DEFINE INDEX idx_ais_in  ON appeared_in_segment FIELDS in;
    `);

    // Graph relation: related_to (entity -> entity)
    await db.query(`
      DEFINE TABLE related_to SCHEMAFULL TYPE RELATION IN entity OUT entity;
      DEFINE FIELD relation_type ON related_to TYPE string;
      DEFINE FIELD weight        ON related_to TYPE float DEFAULT 1.0;
      DEFINE FIELD first_seen    ON related_to TYPE datetime;
      DEFINE FIELD last_seen     ON related_to TYPE datetime;
      DEFINE FIELD count         ON related_to TYPE int DEFAULT 1;
      DEFINE FIELD created_at    ON related_to TYPE datetime DEFAULT time::now();
      DEFINE INDEX idx_related_type   ON related_to FIELDS relation_type;
      DEFINE INDEX idx_related_unique ON related_to FIELDS in, out, relation_type UNIQUE;
    `);
  },
};
