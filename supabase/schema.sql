-- JHU Course Planner Schema for Supabase

-- Courses table
CREATE TABLE IF NOT EXISTS courses (
  id SERIAL PRIMARY KEY,
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
  description TEXT DEFAULT '',
  prerequisites TEXT DEFAULT '',
  corequisites TEXT DEFAULT '',
  restrictions TEXT DEFAULT '',
  all_departments TEXT DEFAULT '',
  overall_quality REAL,
  instructor_effectiveness REAL,
  intellectual_challenge REAL,
  workload REAL,
  feedback_usefulness REAL,
  num_evaluations INTEGER DEFAULT 0,
  num_respondents INTEGER DEFAULT 0,
  UNIQUE(offering_name, section_name, term)
);

CREATE INDEX IF NOT EXISTS idx_courses_title ON courses(title);
CREATE INDEX IF NOT EXISTS idx_courses_department ON courses(department);
CREATE INDEX IF NOT EXISTS idx_courses_school ON courses(school_name);
CREATE INDEX IF NOT EXISTS idx_courses_status ON courses(status);
CREATE INDEX IF NOT EXISTS idx_courses_level ON courses(level);
CREATE INDEX IF NOT EXISTS idx_courses_instructors ON courses(instructors_full_name);
CREATE INDEX IF NOT EXISTS idx_courses_offering ON courses(offering_name);
CREATE INDEX IF NOT EXISTS idx_courses_term ON courses(term);

-- Professors table (RateMyProfessors data)
CREATE TABLE IF NOT EXISTS professors (
  id SERIAL PRIMARY KEY,
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

-- Evaluations table
CREATE TABLE IF NOT EXISTS evaluations (
  id SERIAL PRIMARY KEY,
  course_code TEXT NOT NULL,
  instance_key TEXT NOT NULL UNIQUE,
  course_name TEXT DEFAULT '',
  instructor TEXT DEFAULT '',
  term TEXT DEFAULT '',
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

-- User schedules (per-term isolation, and a few parallel schedules per visitor)
CREATE TABLE IF NOT EXISTS schedules (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  offering_name TEXT NOT NULL,
  section_name TEXT NOT NULL,
  term TEXT NOT NULL DEFAULT 'Fall 2026',
  -- Schedule 1/2/3. Defaulting to 1 is what let this column be added to a
  -- populated table without moving anybody's existing schedule.
  schedule_slot SMALLINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- The slot belongs in the key: without it, adding a class that is already in
  -- one schedule to another collides and the upsert moves the row instead of
  -- inserting a second copy.
  CONSTRAINT schedules_unique_per_slot
    UNIQUE(session_id, schedule_slot, offering_name, section_name, term),
  CONSTRAINT schedules_slot_range CHECK (schedule_slot BETWEEN 1 AND 3)
);

CREATE INDEX IF NOT EXISTS idx_schedules_session ON schedules(session_id);
CREATE INDEX IF NOT EXISTS idx_schedules_term ON schedules(term);
CREATE INDEX IF NOT EXISTS idx_schedules_session_slot ON schedules(session_id, schedule_slot, term);

-- Course catalogue (term-independent, from e-catalogue)
CREATE TABLE IF NOT EXISTS catalogue (
  id SERIAL PRIMARY KEY,
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

-- Program requirements (user-defined degree requirements)
CREATE TABLE IF NOT EXISTS program_requirements (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  program_name TEXT NOT NULL DEFAULT 'My Program',
  requirements JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(session_id, program_name)
);

CREATE INDEX IF NOT EXISTS idx_requirements_session ON program_requirements(session_id);

-- Available terms metadata
CREATE TABLE IF NOT EXISTS available_terms (
  term TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL,
  has_sis_data BOOLEAN DEFAULT FALSE,
  course_count INTEGER DEFAULT 0,
  is_current BOOLEAN DEFAULT FALSE
);
