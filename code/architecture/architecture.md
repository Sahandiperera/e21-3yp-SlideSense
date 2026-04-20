# SlideSense — System Architecture

> IoT-Based Landslide Detection & Early Warning System

---

## 1. High-Level Overview

```
┌──────────────────────────────┐   MQTT    ┌──────────────────┐
│  Raspberry Pi Node           ├─────────►│  AWS IoT Core     │
│  (Sensors + Wi-Fi AP + MQTT) │          │  (Message Broker) │
└──────────┬───────────────────┘          └────────┬───────────┘
           │ Local Wi-Fi                           │
           ▼                                       ▼
   ┌──────────────┐                       ┌──────────────────┐
   │  Mobile App  │◄─────────────────────►│  Backend (FastAPI)│
   │  (Flutter)   │        HTTPS          │  on AWS EC2       │
   └──────────────┘                       └────────┬─────────┘
                                                   │
                              ┌─────────────────────┼──────────────┐
                              ▼                     ▼              ▼
                     ┌─────────────────┐  ┌────────────────┐  ┌──────────────┐
                     │ PostgreSQL +    │  │ Admin Web      │  │ Research API │
                     │ TimescaleDB     │  │ Dashboard      │  │ (Public)     │
                     │ (AWS RDS)       │  │ (React)        │  │ /api/v1/pub  │
                     └─────────────────┘  └────────────────┘  └──────────────┘
```

**Three layers:** Hardware (Raspberry Pi nodes with sensors) → Cloud Backend → Interface (Mobile + Admin + Research API).

Each Raspberry Pi node reads sensors directly (GPIO / I2C / SPI), runs a local Wi-Fi AP for nearby mobile devices, and publishes telemetry to the cloud via MQTT.

---

## 2. Database Structure

### 2.1 Schema Design

Two logical partitions inside a single PostgreSQL + TimescaleDB instance on AWS RDS.

#### A. Time-Series Store (TimescaleDB Hypertables)

```sql
-- Core sensor readings — converted to a hypertable on `recorded_at`
CREATE TABLE sensor_readings (
    id              BIGSERIAL,
    probe_id        UUID        NOT NULL REFERENCES probes(id),
    recorded_at     TIMESTAMPTZ NOT NULL,
    moisture        REAL,           -- % saturation
    tilt_x          REAL,           -- degrees
    tilt_y          REAL,
    tilt_z          REAL,
    vibration_mag   REAL,           -- m/s²
    rainfall_mm     REAL,
    sampling_mode   VARCHAR(10)     -- 'normal' | 'burst'
);
SELECT create_hypertable('sensor_readings', 'recorded_at');

-- Continuous aggregate for dashboards / research API
CREATE MATERIALIZED VIEW hourly_readings
WITH (timescaledb.continuous) AS
SELECT
    probe_id,
    time_bucket('1 hour', recorded_at) AS bucket,
    AVG(moisture)      AS avg_moisture,
    MAX(vibration_mag) AS max_vibration,
    SUM(rainfall_mm)   AS total_rainfall
FROM sensor_readings
GROUP BY probe_id, bucket;
```

#### B. Relational Store (Standard PostgreSQL Tables)

```sql
CREATE TABLE households (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(120)    NOT NULL,
    location        GEOGRAPHY(POINT, 4326),
    max_devices     SMALLINT        NOT NULL DEFAULT 5,
    created_at      TIMESTAMPTZ     DEFAULT now()
);

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id    UUID            NOT NULL REFERENCES households(id),
    email           VARCHAR(255)    UNIQUE NOT NULL,
    password_hash   TEXT            NOT NULL,       -- bcrypt
    role            VARCHAR(20)     NOT NULL DEFAULT 'resident',
                                    -- resident | admin | researcher
    created_at      TIMESTAMPTZ     DEFAULT now()
);

CREATE TABLE devices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID            NOT NULL REFERENCES users(id),
    device_token    TEXT            NOT NULL,       -- FCM / APNS push token
    digital_key     TEXT            NOT NULL UNIQUE,-- signed JWT for local auth
    is_active       BOOLEAN         DEFAULT true,
    registered_at   TIMESTAMPTZ     DEFAULT now()
);

CREATE TABLE probes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id    UUID            NOT NULL REFERENCES households(id),
    hw_serial       VARCHAR(64)     UNIQUE NOT NULL,
    firmware_ver    VARCHAR(20),
    latitude        DOUBLE PRECISION,
    longitude       DOUBLE PRECISION,
    status          VARCHAR(20)     DEFAULT 'online',  -- online | offline | maintenance
    installed_at    TIMESTAMPTZ     DEFAULT now()
);

CREATE TABLE alerts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    probe_id        UUID            NOT NULL REFERENCES probes(id),
    level           SMALLINT        NOT NULL,       -- 1=Normal, 2=Warning, 3=Dangerous
    triggered_at    TIMESTAMPTZ     NOT NULL,
    resolved_at     TIMESTAMPTZ,
    details         JSONB
);

CREATE TABLE api_keys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_email     VARCHAR(255)    NOT NULL,
    key_hash        TEXT            NOT NULL,       -- SHA-256 of the issued key
    rate_limit      INT             DEFAULT 100,    -- requests/hour
    scopes          TEXT[]          DEFAULT '{read}',
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ     DEFAULT now()
);
```

### 2.2 Data Retention Policy

| Granularity | Retention | Purpose |
|---|---|---|
| Raw readings (10 s – 15 min) | 90 days | Incident forensics |
| Hourly aggregates | 2 years | Trend analysis / Research API |
| Daily aggregates | Indefinite | Long-term geological study |

Implemented via TimescaleDB `add_retention_policy()`.

---

## 3. Backend Software Architecture

### 3.1 Component Map

```
                    ┌─────────────────────────────────────────┐
                    │           AWS EC2 Instance               │
                    │                                         │
  MQTT (TLS)        │  ┌────────────┐    ┌────────────────┐  │
  ──────────────────►  │ MQTT Ingestion│──►│ Validation &   │  │
  (AWS IoT Core)    │  │ Worker      │   │ Normalisation  │  │
                    │  └────────────┘    └───────┬────────┘  │
                    │                            │            │
                    │                   ┌────────▼────────┐  │
                    │                   │  Risk Analysis   │  │
                    │                   │  Engine          │  │
                    │                   └────────┬────────┘  │
                    │                            │            │
                    │         ┌──────────────────┼──────┐    │
                    │         ▼                  ▼      ▼    │
                    │  ┌────────────┐  ┌────────┐ ┌───────┐ │
                    │  │ Notification│  │ DB     │ │ Cache │ │
                    │  │ Service    │  │ Writer │ │ Redis │ │
                    │  │ (FCM/APNS) │  │        │ │       │ │
                    │  └────────────┘  └────────┘ └───────┘ │
                    │                                        │
  HTTPS (TLS 1.3)  │  ┌────────────────────────────────┐    │
  ──────────────────►  │       FastAPI Application       │    │
  (Mobile/Web/API)  │  │  /auth  /data  /alerts  /admin  │    │
                    │  │  /api/v1/public (Research)      │    │
                    │  └────────────────────────────────┘    │
                    └─────────────────────────────────────────┘
```

### 3.2 Core Services (Python / FastAPI)

| Service | Responsibility |
|---|---|
| **MQTT Ingestion Worker** | Subscribes to `probes/{probe_id}/telemetry`. Validates incoming JSON payloads (schema + HMAC signature). |
| **Validation & Normalisation** | Rejects out-of-range values, converts units, tags `sampling_mode`. |
| **Risk Analysis Engine** | Applies 3-level alert logic. If vibration + moisture exceed thresholds → level 3 alert. Runs as an async task. |
| **Notification Service** | Pushes FCM (Android) / APNS (iOS) notifications. Escalates level 3 to SMS via AWS SNS. |
| **DB Writer** | Batch-inserts readings into TimescaleDB. Writes alerts to the `alerts` table. |
| **Redis Cache** | Stores latest reading per probe for sub-second API responses. Caches JWT blacklist for logout. |

### 3.3 API Route Groups

```
/auth
    POST   /register          — sign up (enforces household device limit)
    POST   /login             — returns JWT access + refresh tokens
    POST   /refresh           — rotate access token
    POST   /logout            — blacklists refresh token

/data
    GET    /probes/{id}/live  — latest cached reading (Redis)
    GET    /probes/{id}/history?range=7d  — time-series query
    GET    /dashboard         — aggregated stats for household

/alerts
    GET    /alerts            — paginated alert history
    POST   /alerts/{id}/ack  — admin acknowledges an alert

/admin  (role: admin)
    GET    /probes            — all probe statuses
    PUT    /probes/{id}/config — update thresholds / sampling mode
    GET    /users             — user management

/api/v1/public  (API key auth, read-only)
    GET    /rainfall-history?region=&from=&to=
    GET    /soil-saturation?region=&from=&to=
```

### 3.4 Device Communication Protocol

- **Transport:** MQTT over TLS (port 8883) via AWS IoT Core.
- **Topic schema:** `probes/{probe_id}/telemetry` (publish), `probes/{probe_id}/cmd` (subscribe for config updates).
- **Payload (JSON):**

```json
{
  "probe_id": "uuid",
  "ts": "2026-03-12T08:30:00Z",
  "moisture": 72.5,
  "tilt": { "x": 0.3, "y": -1.2, "z": 0.0 },
  "vibration": 0.04,
  "rainfall_mm": 2.1,
  "mode": "normal",
  "hmac": "sha256-signature"
}
```

### 3.5 Sampling Mode Switching

| Condition | Action |
|---|---|
| All values normal | 15-min interval (`normal`) |
| Any single threshold crossed | 1-min interval (`elevated`) |
| Vibration **and** moisture critical | 10-sec interval (`burst`) — triggers level 3 alert |

Switching is commanded server-side via `probes/{id}/cmd` or locally by the Raspberry Pi node software.

---

## 4. Mobile App Architecture

### 4.1 Platform & Framework

- **Flutter** (single codebase for Android & iOS).
- Native platform channels for: background alarm audio, Wi-Fi SSID detection, local notifications.

### 4.2 Dual-Connection Model

```
┌─────────────────────────────────────────────┐
│                  Mobile App                 │
│                                             │
│  ┌─────────────┐       ┌─────────────────┐  │
│  │ Local Mode  │       │ Remote Mode     │  │
│  │ (WebSocket) │       │ (HTTPS/REST)    │  │
│  │ ◄──► R-Pi   │       │ ◄──► Cloud API  │  │
│  │ via Wi-Fi   │       │ via 4G/5G       │  │
│  └──────┬──────┘       └───────┬─────────┘  │
│         │   Connection Manager │            │
│         └──────────┬───────────┘            │
│                    ▼                        │
│         ┌──────────────────┐                │
│         │  Unified Data    │                │
│         │  Layer (BLoC)    │                │
│         └──────────────────┘                │
└─────────────────────────────────────────────┘
```

| Mode | Trigger | Data Source | Latency |
|---|---|---|---|
| **Mode A — Local (Parallel Link)** | Phone connected to probe Wi-Fi SSID | Live sensor stream from Raspberry Pi **+** cloud analytics | < 1 s |
| **Mode B — Remote (Internet Link)** | Away from home / no probe Wi-Fi | Cloud API (last synced + historical) | 1–3 s |

Switching is automatic — the Connection Manager monitors the current Wi-Fi SSID and toggles seamlessly.

### 4.3 State Management & Layers

```
Presentation (UI)
    └── BLoC / Cubit  (state management)
           └── Repository Layer (abstracts data source)
                  ├── LocalDataSource  (WebSocket to Raspberry Pi)
                  ├── RemoteDataSource (REST to Cloud API)
                  └── CacheDataSource  (SQLite / Hive for offline)
```

### 4.4 Key Features

| Feature | Implementation |
|---|---|
| **Real-time dashboard** | WebSocket stream (local) or Server-Sent Events (remote). |
| **Emergency alarm** | Foreground service (Android) / background mode (iOS). Plays alarm audio even when phone is locked. |
| **Deep analysis charts** | Pulled from cloud; rendered with `fl_chart`. |
| **Auto-connect switching** | `NetworkInfo` plugin detects probe SSID → switches data source. |
| **Offline cache** | Last 24 h of readings stored locally in SQLite for zero-connectivity scenarios. |
| **Push notifications** | FCM (Android) + APNS (iOS) for warning/danger alerts. |

### 4.5 Device Registration Flow

```
1. User signs up → Cloud checks household device count against max_devices.
2. If under limit → backend issues a signed JWT ("digital key"), stored in secure storage.
3. On local connect → Raspberry Pi verifies the digital key signature (public key on device).
4. Valid key → live data stream granted. Invalid/expired → connection refused.
```

---

## 5. Admin Web Dashboard

- **Stack:** React + Vite, TanStack Query, Leaflet (maps), Recharts (graphs).
- **Auth:** Same JWT-based auth; requires `admin` role.
- **Features:** Real-time probe map, threshold configuration, user management, alert history with acknowledge workflow.

---

## 6. Research API

- Separate route group `/api/v1/public` — no user PII exposed.
- **Auth:** API key (hashed in `api_keys` table), passed via `X-API-Key` header.
- **Rate limit:** Configurable per key (default 100 req/hr) enforced by Redis sliding window.
- **Data:** Returns only aggregated environmental metrics (rainfall, soil saturation) — never user data or precise probe GPS.

---

## 7. Security Architecture

### 7.1 Authentication & Authorization

| Layer | Mechanism |
|---|---|
| Mobile ↔ Cloud | JWT (RS256) access + refresh tokens. Access token TTL: 15 min. Refresh TTL: 7 days. Refresh rotation on every use. |
| Raspberry Pi ↔ AWS IoT Core | Mutual TLS (X.509 certificates per device). |
| Mobile ↔ Raspberry Pi (local) | Signed digital key (JWT verified offline by Raspberry Pi using stored public key). |
| Admin Dashboard | JWT + role-based access control (`admin` role required). |
| Research API | HMAC-SHA256 API keys, rate-limited, read-only scope. |

### 7.2 Data Protection

| Concern | Measure |
|---|---|
| **Transport encryption** | TLS 1.3 on all HTTPS and MQTT connections. |
| **Data at rest** | AWS RDS encryption (AES-256). Encrypted EBS volumes. |
| **Password storage** | bcrypt with cost factor ≥ 12. |
| **Secrets management** | AWS Secrets Manager for DB credentials, JWT signing keys, IoT certs. |
| **PII minimisation** | Research API returns only environmental aggregates — no user/location data. |

### 7.3 Device & Network Security

| Concern | Measure |
|---|---|
| **Probe authentication** | Each Raspberry Pi has a unique X.509 cert; revocable via AWS IoT Core. |
| **Payload integrity** | HMAC-SHA256 signature on every MQTT payload; rejected if invalid. |
| **Device limit enforcement** | Server-side check (max devices per household) + digital key expiry. |
| **Local Wi-Fi hardening** | WPA3 on probe AP; digital key required before data stream. |
| **Anti-theft** | Tamper-detect circuit; optional low-voltage deterrent on enclosure. |

### 7.4 Application Security

| Concern | Measure |
|---|---|
| **Input validation** | Pydantic models in FastAPI — strict schema validation on all endpoints. |
| **SQL injection** | Parameterized queries via SQLAlchemy ORM — no raw string interpolation. |
| **Rate limiting** | Global rate limit (Nginx) + per-key limit for Research API (Redis). |
| **CORS** | Allowlist of dashboard and app origins only. |
| **Dependency scanning** | Automated `pip-audit` / `npm audit` in CI. |
| **JWT blacklist** | Revoked refresh tokens stored in Redis with TTL matching token expiry. |
| **Secure storage (mobile)** | Digital keys stored in Android Keystore / iOS Keychain — never in plain-text. |

### 7.5 Monitoring & Incident Response

- **CloudWatch** alarms for anomalous MQTT throughput, API error rates, DB connection spikes.
- Alert-level escalation: level 3 events auto-notify admin via SMS (AWS SNS) + email.
- Audit log table for admin actions (user management, threshold changes).

---

## 8. Deployment Overview

```
GitHub Actions CI/CD
    ├── Lint + Test + Security Scan
    ├── Build Docker image → push to ECR
    └── Deploy to EC2 (blue/green via CodeDeploy)

Infrastructure (Terraform)
    ├── VPC + subnets (public/private)
    ├── EC2 (FastAPI) in private subnet behind ALB
    ├── RDS PostgreSQL (TimescaleDB) in private subnet
    ├── ElastiCache Redis
    ├── AWS IoT Core (device registry + rules)
    └── S3 (firmware OTA binaries)
```

---

## 9. Technology Summary

| Component | Technology |
|---|---|
| Node controller | Raspberry Pi (sensors connected directly via GPIO / I2C / SPI) |
| Node-to-Cloud comms | MQTT over TLS (Wi-Fi / Ethernet) |
| Hub-to-Cloud protocol | MQTT over TLS (AWS IoT Core) |
| Backend language | Python 3.12 |
| API framework | FastAPI |
| Database | PostgreSQL 16 + TimescaleDB |
| Cache | Redis |
| Mobile app | Flutter (Android + iOS) |
| Admin dashboard | React + Vite |
| Cloud platform | AWS (EC2, RDS, IoT Core, SNS, S3) |
| IaC | Terraform |
| CI/CD | GitHub Actions |
