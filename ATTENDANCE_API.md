# Attendance Module API Specification

Base path: `/api/attendance`

All API responses follow the standard JSON response envelope:
```json
{
  "success": true,
  "message": "Optional message string",
  "data": { ... }
}
```

Errors use HTTP status codes and provide error details:
```json
{
  "success": false,
  "message": "Error description"
}
```

---

## Authentication Schemes

1. **Employee Routes**:
   - Header: `Authorization: Bearer <site_user_jwt_token>`
   - Requirements: Valid site-user JWT (`type: 'site_user'`) signed with `JWT_SECRET`, user is active (`is_active = 1`), and `module_access` contains `'Attendance'`.
   - Rejection: Returns `401 Unauthorized` for missing/invalid tokens; returns `403 Forbidden` (`{"success":false,"message":"Access denied: Attendance module access required."}`) if the user lacks the Attendance module.

2. **Admin Routes**:
   - Header: `Authorization: Bearer <admin_jwt_token>`
   - Requirements: Valid admin JWT from `admins` table (`role: 'superadmin' | 'admin'`).
   - Rejection: Returns `401 Unauthorized` for missing/invalid tokens.

---

## Implemented Endpoints (Step B)

### 1. Health Probe
- **Method & Path**: `GET /api/attendance/ping`
- **Auth**: Public (No auth required)
- **Success Response (200)**:
  ```json
  {
    "success": true,
    "message": "attendance ok",
    "data": {
      "module": "attendance"
    }
  }
  ```

---

### 2. Employee Status
- **Method & Path**: `GET /api/attendance/me/status`
- **Auth**: Employee (`siteUserProtect` + `requireModule('Attendance')`)
- **Success Response (200)**:
  ```json
  {
    "success": true,
    "data": {
      "office": {
        "id": 1,
        "name": "Headquarters",
        "lat": 12.9715987,
        "lng": 77.5945627,
        "radius_m": 150,
        "accuracy_max_m": 50,
        "heartbeat_seconds": 60,
        "shift_start": "09:30:00",
        "shift_end": "18:30:00",
        "grace_minutes": 10,
        "outside_tolerance_minutes": 10,
        "reverify_count": 2,
        "require_both": 0,
        "hasIpAllowlist": false
      },
      "faceEnrolled": true,
      "consentGiven": true,
      "consentAt": "2026-10-03T10:00:00.000Z",
      "todayRecord": {
        "id": 42,
        "user_id": "tbusr001",
        "attendance_date": "2026-10-03",
        "fullname": "Nandha Kumar",
        "office_id": 1,
        "check_in_at": "2026-10-03 04:05:00",
        "check_out_at": null,
        "status": "PRESENT",
        "worked_minutes": 120,
        "check_in_lat": 12.9716,
        "check_in_lng": 77.5945,
        "check_in_accuracy": 15.0,
        "check_out_lat": null,
        "check_out_lng": null,
        "check_out_accuracy": null,
        "ip": "203.0.113.195",
        "created_at": "2026-10-03 04:05:00",
        "updated_at": "2026-10-03 06:05:00"
      },
      "presenceState": "INSIDE",
      "reverifyPending": false,
      "reverifyDueAt": null
    }
  }
  ```
- **Error Responses**:
  - `400 Bad Request`: `{"success":false,"message":"No office is assigned to this employee."}`

---

### 3. Record Consent
- **Method & Path**: `POST /api/attendance/me/consent`
- **Auth**: Employee (`siteUserProtect` + `requireModule('Attendance')`)
- **Request Body**:
  ```json
  {
    "version": "1.0"
  }
  ```
- **Success Response (200)**:
  ```json
  {
    "success": true,
    "message": "Consent recorded successfully",
    "data": {
      "userId": "tbusr001",
      "consentAt": "2026-10-03T15:30:00.000Z",
      "version": "1.0"
    }
  }
  ```

---

### 4. Request Challenge
- **Method & Path**: `POST /api/attendance/challenge`
- **Auth**: Employee (`siteUserProtect` + `requireModule('Attendance')`)
- **Request Body**:
  ```json
  {
    "purpose": "checkin",
    "lat": 12.9715987,
    "lng": 77.5945627,
    "accuracy": 12.5
  }
  ```
- **Validation Constraints**:
  - `purpose`: Must be `'checkin'` or `'reverify'`.
  - `lat`: Finite number between `-90` and `90`.
  - `lng`: Finite number between `-180` and `180`.
  - `accuracy`: Finite non-negative number $\le$ `accuracy_max_m` (default 50m).
- **Success Response (200)**:
  ```json
  {
    "success": true,
    "message": "Challenge issued",
    "data": {
      "challengeId": "550e8400-e29b-41d4-a716-446655440000",
      "action": "blink twice",
      "expiresAt": "2026-10-03T15:31:00.000Z"
    }
  }
  ```
- **Error Responses**:
  - `400 Bad Request`: `{"success":false,"message":"GPS accuracy is too low. Move to an area with clear sky view."}` (accuracy > 50m)
  - `400 Bad Request`: `{"success":false,"message":"You are outside the designated office radius."}`
  - `403 Forbidden`: `{"success":false,"message":"Consent is required before requesting a challenge."}`
  - `429 Too Many Requests`: `{"success":false,"message":"Too many failed attempts. Try again in X minute(s)."}`

---

### 5. Check-In
- **Method & Path**: `POST /api/attendance/check-in`
- **Auth**: Employee (`siteUserProtect` + `requireModule('Attendance')`)
- **Request Body**:
  ```json
  {
    "challengeId": "550e8400-e29b-41d4-a716-446655440000",
    "descriptors": [
      [0.051, -0.023, ...],
      [0.053, -0.021, ...],
      [0.052, -0.022, ...]
    ],
    "lat": 12.9715987,
    "lng": 77.5945627,
    "accuracy": 15.0
  }
  ```
- **Validation & Business Rules**:
  - Exactly 3 descriptor arrays of 128 numbers each.
  - Replay check: pairwise distance must exceed `FACE_REPLAY_EPSILON` (default `0.004`).
  - Single-use challenge: challenge is marked used atomically; cannot be reused even on failure.
  - Timing: Challenge response must arrive between 2s and 45s after issuance.
  - Match: Euclidean distance against logged-in user's enrolled template must be $\le$ `FACE_MATCH_THRESHOLD` (default `0.5`).
- **Success Response (200)**:
  ```json
  {
    "success": true,
    "message": "Check-in successful",
    "data": {
      "recordId": 101,
      "status": "PRESENT",
      "attendanceDate": "2026-10-03",
      "checkInAt": "2026-10-03T04:05:00.000Z"
    }
  }
  ```
- **Error Responses**:
  - `400 Bad Request`: `{"success":false,"message":"Challenge has already been used."}`
  - `400 Bad Request`: `{"success":false,"message":"Challenge has expired."}`
  - `400 Bad Request`: `{"success":false,"message":"Liveness capture was too fast. Retry the challenge."}`
  - `400 Bad Request`: `{"success":false,"message":"Liveness failed: face samples look identical (possible photo replay)."}`
  - `400 Bad Request`: `{"success":false,"message":"Face verification failed: descriptor distance above threshold."}`
  - `403 Forbidden`: `{"success":false,"message":"Consent is required before check-in."}`
  - `409 Conflict`: `{"success":false,"message":"Attendance already recorded for today."}`
  - `429 Too Many Requests`: `{"success":false,"message":"Too many failed attempts. Try again in X minute(s)."}`

---

### 6. Presence Heartbeat
- **Method & Path**: `POST /api/attendance/heartbeat`
- **Auth**: Employee (`siteUserProtect` + `requireModule('Attendance')`)
- **Request Body**:
  ```json
  {
    "lat": 12.9715987,
    "lng": 77.5945627,
    "accuracy": 20.0
  }
  ```
- **Behavior**:
  - Only allowed while an open attendance record exists for today.
  - **Three-Way GPS Classification**:
    - $a > 4 \times \text{accuracy\_max\_m}$: Weak reading. Does not refresh `last_inside_at`; increments `weak_streak`; at $\ge 3$ consecutive weak readings, transitions state to `UNKNOWN` with reason `"weak_gps"`.
    - $d + a \le R$: Inside proven. Refreshes `last_inside_at`, resets weak and outside streaks.
    - $d - a > R$: Outside proven. Transitions to `OUTSIDE` with reason `"left"`.
    - $d \le R$: Probably inside. Refreshes `last_inside_at`, resets weak streak.
    - Ambiguous outside ($d > R$ but circle overlaps): `outside_streak += 1`; at $\ge 2$ consecutive outside readings transitions to `OUTSIDE` with reason `"left"`.
  - **Return Flow**: Once `OUTSIDE`, returning physically inside does NOT change state back to `INSIDE` via heartbeat. State remains `OUTSIDE` until `/reverify` passes.
- **Success Response (200)**:
  ```json
  {
    "success": true,
    "data": {
      "state": "INSIDE",
      "reason": null,
      "reverifyPending": false,
      "reverifyDueAt": null,
      "lastHeartbeatAt": "2026-10-03T15:35:00.000Z"
    }
  }
  ```
- **Error Responses**:
  - `409 Conflict`: `{"success":false,"message":"No open attendance record found for today."}`

---

### 7. Re-Verification
- **Method & Path**: `POST /api/attendance/reverify`
- **Auth**: Employee (`siteUserProtect` + `requireModule('Attendance')`)
- **Request Body**:
  ```json
  {
    "challengeId": "660e8400-e29b-41d4-a716-446655440001",
    "descriptors": [
      [0.051, -0.023, ...],
      [0.053, -0.021, ...],
      [0.052, -0.022, ...]
    ],
    "lat": 12.9715987,
    "lng": 77.5945627,
    "accuracy": 15.0
  }
  ```
- **Behavior**:
  - Validates `reverify` purpose challenge inside office radius.
  - Closes outside interval and restores `INSIDE` state when returning.
  - Marks scheduled random reverify task `COMPLETED` if pending.
- **Success Response (200)**:
  ```json
  {
    "success": true,
    "message": "Re-verification successful",
    "data": {
      "state": "INSIDE",
      "reverified": true
    }
  }
  ```
- **Error Responses**:
  - `400 Bad Request`: `{"success":false,"message":"Face verification failed: descriptor distance above threshold."}`
  - `403 Forbidden`: `{"success":false,"message":"Consent is required before re-verification."}`
  - `409 Conflict`: `{"success":false,"message":"No open attendance record found for today."}`

---

### 8. Check-Out
- **Method & Path**: `POST /api/attendance/check-out`
- **Auth**: Employee (`siteUserProtect` + `requireModule('Attendance')`)
- **Request Body**:
  ```json
  {
    "lat": 12.9715987,
    "lng": 77.5945627,
    "accuracy": 25.0
  }
  ```
- **Behavior**:
  - Allowed from any location (stores checkout coordinates).
  - Closes active presence interval and computes `worked_minutes` strictly as sum of `INSIDE` intervals.
- **Success Response (200)**:
  ```json
  {
    "success": true,
    "message": "Check-out successful",
    "data": {
      "recordId": 101,
      "checkOutAt": "2026-10-03T18:30:00.000Z",
      "workedMinutes": 480,
      "status": "PRESENT"
    }
  }
  ```
- **Error Responses**:
  - `409 Conflict`: `{"success":false,"message":"No open attendance record found to check out."}`

---

### 9. Attendance History
- **Method & Path**: `GET /api/attendance/me/history?month=YYYY-MM`
- **Auth**: Employee (`siteUserProtect` + `requireModule('Attendance')`)
- **Success Response (200)**:
  ```json
  {
    "success": true,
    "data": {
      "month": "2026-10",
      "records": [
        {
          "id": 101,
          "user_id": "tbusr001",
          "attendance_date": "2026-10-03",
          "fullname": "Nandha Kumar",
          "office_id": 1,
          "check_in_at": "2026-10-03 04:05:00",
          "check_out_at": "2026-10-03 12:05:00",
          "status": "PRESENT",
          "worked_minutes": 480,
          "check_in_lat": 12.9716,
          "check_in_lng": 77.5945,
          "check_in_accuracy": 15.0,
          "check_out_lat": 12.9718,
          "check_out_lng": 77.5942,
          "check_out_accuracy": 20.0,
          "ip": "203.0.113.195"
        }
      ]
    }
  }
  ```

---

### 10. Regularization Request
- **Method & Path**: `POST /api/attendance/regularization`
- **Auth**: Employee (`siteUserProtect` + `requireModule('Attendance')`)
- **Request Body**:
  ```json
  {
    "date": "2026-10-03",
    "reason": "Forgot to check in due to client meeting"
  }
  ```
- **Success Response (200)**:
  ```json
  {
    "success": true,
    "message": "Regularization request submitted successfully",
    "data": {
      "id": 12,
      "date": "2026-10-03",
      "status": "PENDING"
    }
  }
  ```

---

### 11. Admin Enrol Face
- **Method & Path**: `POST /api/attendance/admin/employees/:userId/face`
- **Auth**: Admin (`protect`)
- **Request Body**:
  ```json
  {
    "descriptors": [
      [0.051, -0.023, ...],
      [0.053, -0.021, ...],
      [0.052, -0.022, ...],
      [0.050, -0.024, ...],
      [0.052, -0.022, ...]
    ]
  }
  ```
- **Validation Constraints**:
  - Requires exactly 5 descriptors of 128 numbers.
  - Rejects if mean pairwise distance $> 0.6$.
  - Employee consent must be on file (`consent_at` not null).
  - Saves AES-256-GCM encrypted mean template; writes `attendance_audit_log`. Never returns raw embeddings.
- **Success Response (200)**:
  ```json
  {
    "success": true,
    "message": "Face template enrolled successfully",
    "data": {
      "userId": "tbusr001",
      "enrolledAt": "2026-10-03T15:40:00.000Z"
    }
  }
  ```
- **Error Responses**:
  - `400 Bad Request`: `{"success":false,"message":"Face descriptors differ too much from each other. Ensure consistent lighting and posture."}`
  - `403 Forbidden`: `{"success":false,"message":"Employee consent is required before face enrolment."}`

---

### 12. Admin Delete Face
- **Method & Path**: `DELETE /api/attendance/admin/employees/:userId/face`
- **Auth**: Admin (`protect`)
- **Success Response (200)**:
  ```json
  {
    "success": true,
    "message": "Face template deleted successfully",
    "data": {
      "userId": "tbusr001"
    }
  }
  ```

---

## Endpoints from Later Phases (Not Yet Built)

The following endpoints will be built in **Phase 3 and Phase 4**:

- `GET /api/attendance/admin/offices` (Phase 4)
- `POST /api/attendance/admin/offices` (Phase 4)
- `PUT /api/attendance/admin/offices/:id` (Phase 4)
- `DELETE /api/attendance/admin/offices/:id` (Phase 4)
- `GET /api/attendance/admin/employees` (Phase 4)
- `PUT /api/attendance/admin/employees/:userId/profile` (Phase 4)
- `GET /api/attendance/admin/live` (Phase 4)
- `GET /api/attendance/admin/stream` (Phase 4 - Server-Sent Events)
- `GET /api/attendance/admin/employees/:userId/timeline` (Phase 4)
- `GET /api/attendance/admin/attempts` (Phase 4)
- `GET /api/attendance/admin/report` (Phase 4 - JSON/CSV export)
- `GET /api/attendance/admin/regularizations` (Phase 4)
- `POST /api/attendance/admin/regularizations/:id/approve` (Phase 4)
- `POST /api/attendance/admin/regularizations/:id/reject` (Phase 4)
- `PATCH /api/attendance/admin/records/:id` (Phase 4 - Manual edit with audit log)
- Background sweeper service: `src/services/attendanceSweeper.js` (Phase 3)
