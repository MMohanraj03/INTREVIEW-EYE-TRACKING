# AI Eye-Tracking Live Interview Proctoring System

An automated, browser-native AI proctoring and technical assessment platform designed for live candidate interviews. The platform combines client-side computer vision (MediaPipe FaceMesh) to monitor candidate eye gaze and head orientation, continuous live screen sharing, meeting scheduling with shareable links, and **strict Admin-directed question controls**.

> **Proctoring Policy**: Candidates must keep their visual attention focused on their laptop screen. **If a candidate looks away from the laptop screen more than 15 times, the session is permanently terminated and locked automatically.**

---

## Key Features

### 1. Real-Time Eye & Head Orientation Tracking
- **MediaPipe FaceMesh (Client-Side)**: 468 3D facial landmarks tracked at 60 FPS directly in the browser via WebAssembly/WebGL—zero local Python computer vision dependencies required.
- **Laptop Screen Envelope & Auto-Calibration**: Accounts for the physical geometry where webcams sit at the top bezel above the screen. Eliminates false warnings while candidates read questions across the full width and height of their display.
- **1-Click Posture Recalibration**: Candidates can click **"Calibrate My Screen"** at any time to adapt to their chair height and laptop lid tilt.
- **Camera Device Switcher**: Detects and switches between built-in laptop webcams and external/virtual cameras.

### 2. Admin-Only Question Control & Question Bank
- **Strict Role Security**: **Only authenticated Admins / Interviewers can change, advance, or assign questions.** Candidates are locked into read-only mode and cannot skip or pick questions.
- **Interviewer Control Bar**: Admin can push Question 1, 2, 3... to the candidate in real-time, step through questions (`◀ Prev` / `Next ▶`), or create custom questions on the fly.
- **Live Question Sync**: Candidate screens automatically update every 2.5 seconds to display the active question selected by the interviewer.
- **Candidate Answer Auto-Save**: Candidate answers are automatically saved per question in local storage and synced to the proctor log.
- **Question Bank CRUD**: Admins can add, edit, and delete questions from the Question Bank directly in the Proctor Dashboard or interview room.

### 3. Continuous Screen Share Proctoring
- **Mandatory Live Screen Sharing**: Candidates must share their screen via the browser Screen Capture API (`getDisplayMedia`).
- **Disconnect Penalty**: Stopping screen sharing triggers an immediate proctor violation warning.

### 4. Automated 15-Warning Termination Engine
- **Per-Second AI Checks**: Off-center eyeball movement (left, right, top, bottom) or looking away from the laptop is checked and flagged.
- **Anti-Cheat Flickering Detector**: Accumulates rapid micro-glances and looking away to notes or second monitors.
- **Unclosable Termination Modal**: Reaching 15 warnings immediately stops the camera, terminates the session on the backend, and locks the room with a timestamped audit log.

### 5. Meeting Scheduling & Shareable Links
- **Schedule Live Interviews**: Set candidate name, email, target role, date, and time.
- **Unique Shareable Links**: Generates meeting codes (e.g. `MEET-A1B2-C3D4`) with a dedicated waiting lobby and verification checks.

### 6. Proctor Audit Dashboard
- **Live Candidate Monitor**: Real-time overview of Scheduled, In Progress, Terminated, and Completed interviews.
- **Violation Audit Log**: Detailed chronological log of every look-away violation with timestamp and reason.
- **Question Management**: Full control to add, edit, or delete questions in the central database.

---

## Technology Stack

- **Backend**: Python 3.8+ & Flask
- **Database**: SQLite with SQLAlchemy ORM
- **Frontend**: HTML5, CSS3, JavaScript (Bootstrap 5, Bootstrap Icons)
- **Computer Vision**: Google MediaPipe FaceMesh & Camera Utils
- **Browser APIs**: `getUserMedia` (Webcam), `getDisplayMedia` (Screen Sharing), `visibilitychange` (Tab Switching)

---

## Project Structure

```
eye_track/
├── app.py                      # Main Flask application, proctoring APIs & Admin endpoints
├── models/
│   └── database.py            # SQLite models (InterviewSession, InterviewQuestion, ViolationLog)
├── templates/
│   ├── base.html              # Base layout with navigation & branding
│   ├── index.html             # Landing portal, quick actions & rules overview
│   ├── interview_schedule.html# Meeting scheduler (date, time & role)
│   ├── meeting_confirmed.html # Meeting link generation & clipboard share
│   ├── interview_lobby.html   # Candidate waiting room & setup briefing
│   ├── interview_start.html   # Instant candidate registration form
│   ├── interview_room.html    # Live webcam interview screen, screen share & Admin controls
│   └── proctor_dashboard.html # Proctor live audit dashboard & Question Bank manager
├── static/
│   ├── css/
│   │   ├── style.css          # Global typography, color schemes & layout styles
│   │   └── interview.css      # Interview workspace, camera HUD & alert banners
│   └── js/
│       ├── main.js            # General UI utilities
│       └── interview_tracker.js# MediaPipe gaze tracking, calibration & anti-cheat engine
├── .gitignore                 # Excludes local databases, caches & virtual environments
├── requirements.txt           # Minimal Python dependencies
└── README.md                  # System documentation
```

---

## Installation & Setup

### 1. Clone the Repository
```bash
git clone https://github.com/MMohanraj03/INTREVIEW-EYE-TRACKING.git
cd INTREVIEW-EYE-TRACKING
```

### 2. Create and Activate Virtual Environment (Optional)
- **Windows**:
  ```bash
  python -m venv venv
  venv\Scripts\activate
  ```
- **macOS / Linux**:
  ```bash
  python3 -m venv venv
  source venv/bin/activate
  ```

### 3. Install Dependencies
```bash
pip install -r requirements.txt
```

### 4. Run the Server
```bash
python app.py
```

### 5. Access the Web Application
Open your browser and navigate to:
```
http://127.0.0.1:5000
```

---

## Default Credentials & Roles

| Role | Access URL | Default Passcode | Permissions |
| :--- | :--- | :--- | :--- |
| **Candidate** | `/interview/join/<MEET-CODE>` or `/interview/<ID>` | *None (Candidate)* | Answer assigned question, webcam & screen share. Cannot change questions. |
| **Admin / Interviewer** | `/interview/<ID>` (Click "Admin Mode") | `admin123` | Push questions live, change active question, add/edit/delete questions. |
| **Proctor** | `/interview/proctor` | *Open Dashboard* | View live audit logs, monitor candidates, manage Question Bank. |

---

## License

This project is open-source under the MIT License.
