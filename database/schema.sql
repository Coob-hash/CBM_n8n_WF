-- Community-Based Maintenance — PoC schema
-- Requires: PostgreSQL 14+. Optional: CREATE EXTENSION vector; (pgvector, for §6.2 RAG upgrade)

CREATE TABLE IF NOT EXISTS technicians (
    id              SERIAL PRIMARY KEY,
    full_name       TEXT NOT NULL,
    email           TEXT NOT NULL UNIQUE,
    skills          TEXT[] NOT NULL,          -- e.g. '{carpentry,doors,locks}'
    zone            TEXT NOT NULL DEFAULT 'building-A',
    rating          NUMERIC(2,1) DEFAULT 4.0, -- 0.0 .. 5.0
    active          BOOLEAN DEFAULT TRUE,
    profile_text    TEXT,                     -- free-text profile (kept for future use)
    last_assigned_at TIMESTAMPTZ,             -- fairness clock: NULL = never assigned -> ranked FIRST
    -- embedding    vector(1536),             -- deliberately NOT used for selection (see design doc §6.2)
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tickets (
    id                  SERIAL PRIMARY KEY,
    status              TEXT NOT NULL DEFAULT 'RECEIVED',
    -- RECEIVED | NEEDS_TRIAGE | LOCALIZED | DUPLICATE | DISPATCHING | ASSIGNED
    -- | ESCALATED | WORK_DONE | PENDING_APPROVAL | REWORK | CLOSED
    reporter_email      TEXT,
    photo_before_url    TEXT,
    photo_after_url     TEXT,
    -- MultiSet localization result (map-local frame)
    map_code            TEXT,
    pos_x               DOUBLE PRECISION,
    pos_y               DOUBLE PRECISION,
    pos_z               DOUBLE PRECISION,
    vps_confidence      DOUBLE PRECISION,
    -- IFC binding
    ifc_global_id       TEXT,
    ifc_class           TEXT,
    ifc_name            TEXT,
    ifc_storey          TEXT,
    ifc_new_version     TEXT,                 -- e.g. model_v2.ifc, set at closure
    -- AI triage
    category            TEXT,
    severity            INT,
    description         TEXT,
    required_skill      TEXT,
    -- Assignment
    technician_id       INT REFERENCES technicians(id),
    scheduled_date      DATE,
    scheduled_slot      TEXT,
    fm_reject_reason    TEXT,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now()
);

-- Fast duplicate lookup (Scenario S3/S9)
CREATE INDEX IF NOT EXISTS idx_tickets_open_element
    ON tickets (ifc_global_id)
    WHERE status NOT IN ('CLOSED', 'DUPLICATE');

-- Append-only audit trail (§6.7)
CREATE TABLE IF NOT EXISTS ticket_events (
    id          SERIAL PRIMARY KEY,
    ticket_id   INT REFERENCES tickets(id),
    event       TEXT NOT NULL,                -- e.g. CREATED, OFFER_SENT, DECLINED, ASSIGNED ...
    payload     JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- Demo data ------------------------------------------------------------------
INSERT INTO technicians (full_name, email, skills, zone, rating, profile_text) VALUES
 ('Mario Rossi',    'mario.rossi@example.com',    '{carpentry,doors,windows,locks}', 'building-A', 4.7,
  'Senior carpenter, 12 years experience with fire doors, hinges, frames and locks.'),
 ('Lucia Bianchi',  'lucia.bianchi@example.com',  '{plumbing,sanitary,heating}',     'building-A', 4.5,
  'Certified plumber, sanitary terminals, radiators, small leaks.'),
 ('Ahmed Karim',    'ahmed.karim@example.com',    '{electrical,lighting,hvac}',      'building-A', 4.8,
  'Licensed electrician, lighting fixtures, switches, HVAC control panels.'),
 ('Giulia Verdi',   'giulia.verdi@example.com',   '{carpentry,furniture,general}',   'building-B', 4.2,
  'General handywoman, furniture assembly/repair, minor carpentry.')
ON CONFLICT (email) DO NOTHING;
