import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "courses.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
  }
  return _db;
}

export function initDb() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offering_name TEXT NOT NULL,
      section_name TEXT NOT NULL,
      title TEXT NOT NULL,
      credits TEXT,
      department TEXT,
      school_name TEXT,
      level TEXT,
      status TEXT,
      dow TEXT,
      time_of_day TEXT,
      meetings TEXT,
      location TEXT,
      building TEXT,
      instruction_method TEXT,
      instructors TEXT,
      instructors_full_name TEXT,
      max_seats TEXT,
      open_seats TEXT,
      waitlisted TEXT,
      is_writing_intensive TEXT,
      areas TEXT,
      repeatable TEXT,
      term TEXT,
      term_start_date TEXT,
      overall_quality REAL,
      instructor_effectiveness REAL,
      intellectual_challenge REAL,
      workload REAL,
      feedback_usefulness REAL,
      num_evaluations INTEGER DEFAULT 0,
      num_respondents INTEGER DEFAULT 0,
      pos_tags TEXT DEFAULT '',
      UNIQUE(offering_name, section_name, term)
    );

    CREATE INDEX IF NOT EXISTS idx_courses_title ON courses(title);
    CREATE INDEX IF NOT EXISTS idx_courses_department ON courses(department);
    CREATE INDEX IF NOT EXISTS idx_courses_school ON courses(school_name);
    CREATE INDEX IF NOT EXISTS idx_courses_status ON courses(status);
    CREATE INDEX IF NOT EXISTS idx_courses_level ON courses(level);
    CREATE INDEX IF NOT EXISTS idx_courses_meetings ON courses(meetings);
    CREATE INDEX IF NOT EXISTS idx_courses_instructors ON courses(instructors_full_name);

    CREATE TABLE IF NOT EXISTS evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_code TEXT NOT NULL,
      instance_key TEXT NOT NULL UNIQUE,
      course_name TEXT DEFAULT '',
      instructor TEXT DEFAULT '',
      term TEXT DEFAULT '',
      term_label TEXT DEFAULT '',
      overall_quality REAL,
      instructor_effectiveness REAL,
      intellectual_challenge REAL,
      workload REAL,
      feedback_usefulness REAL,
      num_respondents INTEGER DEFAULT 0,
      num_enrolled INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_eval_course ON evaluations(course_code);
    CREATE INDEX IF NOT EXISTS idx_eval_instructor ON evaluations(instructor);

    CREATE TABLE IF NOT EXISTS professors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      department TEXT,
      avg_rating REAL,
      avg_difficulty REAL,
      num_ratings INTEGER DEFAULT 0,
      would_take_again_pct REAL,
      rmp_id TEXT,
      UNIQUE(first_name, last_name, department)
    );

    CREATE INDEX IF NOT EXISTS idx_prof_last_name ON professors(last_name);
    CREATE INDEX IF NOT EXISTS idx_prof_department ON professors(department);
    CREATE INDEX IF NOT EXISTS idx_prof_rating ON professors(avg_rating);

    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      offering_name TEXT NOT NULL,
      section_name TEXT NOT NULL,
      term TEXT NOT NULL DEFAULT 'Spring 2027',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(session_id, offering_name, section_name, term)
    );

    CREATE INDEX IF NOT EXISTS idx_schedules_session ON schedules(session_id);
    CREATE INDEX IF NOT EXISTS idx_schedules_term ON schedules(term);

    CREATE TABLE IF NOT EXISTS catalogue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offering_name TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      credits TEXT,
      department TEXT,
      description TEXT DEFAULT '',
      prerequisites TEXT DEFAULT '',
      corequisites TEXT DEFAULT '',
      restrictions TEXT DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_catalogue_title ON catalogue(title);
    CREATE INDEX IF NOT EXISTS idx_catalogue_department ON catalogue(department);
    CREATE INDEX IF NOT EXISTS idx_catalogue_offering ON catalogue(offering_name);

    CREATE TABLE IF NOT EXISTS program_requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      program_name TEXT NOT NULL DEFAULT 'My Program',
      requirements TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(session_id, program_name)
    );

    CREATE INDEX IF NOT EXISTS idx_requirements_session ON program_requirements(session_id);

    CREATE TABLE IF NOT EXISTS available_terms (
      term TEXT PRIMARY KEY,
      sort_order INTEGER NOT NULL,
      has_sis_data INTEGER DEFAULT 0,
      course_count INTEGER DEFAULT 0,
      is_current INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_courses_term ON courses(term);
    CREATE INDEX IF NOT EXISTS idx_courses_offering ON courses(offering_name);
  `);
  return db;
}
